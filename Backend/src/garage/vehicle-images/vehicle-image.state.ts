import { VehicleImageStatus } from '@prisma/client';
import type { PipelineStatusResult } from './vehicle-image.pipeline-client';
import { isApprovedCatalogAssetKey } from './vehicle-image.catalog';

/**
 * Internal reasons stored on `vehicle_image_identities.reason`.
 *
 *   generation_failed / rejected: the pipeline's own terminal job states. The
 *     pipeline never restarts these by itself; only its administrator regenerates.
 *     This backend never re-requests them either.
 *   dispatch_failed / request_missing: the request never reached the pipeline, or
 *     the pipeline lost it. No AI job failed, so the next new Garage vehicle with
 *     the same identity sends the request again.
 *   awaiting_publication: approved by the pipeline but with no public HTTPS URL
 *     yet. Stays `pending`, and no URL is exposed.
 *   not_requested: a verified identity with no approved registry image, saved while
 *     the pipeline integration is off. Nothing was asked of the pipeline, so the
 *     next new Garage vehicle with this identity asks once it is on.
 */
export const IDENTITY_REASONS = {
  GENERATION_FAILED: 'generation_failed',
  REJECTED: 'rejected',
  DISPATCH_FAILED: 'dispatch_failed',
  REQUEST_MISSING: 'request_missing',
  AWAITING_PUBLICATION: 'awaiting_publication',
  IDENTITY_REVIEW_REQUIRED: 'identity_review_required',
  NOT_REQUESTED: 'not_requested',
} as const;

export const REDISPATCHABLE_REASONS: ReadonlySet<string> = new Set([
  IDENTITY_REASONS.DISPATCH_FAILED,
  IDENTITY_REASONS.REQUEST_MISSING,
  IDENTITY_REASONS.NOT_REQUESTED,
]);

const MINUTE = 60_000;
/** How soon the background sync looks at an identity again, by pipeline state. */
const RESYNC_AFTER_MS: Record<string, number> = {
  queued: 2 * MINUTE,
  running: 2 * MINUTE,
  awaiting_approval: 10 * MINUTE,
  // Waiting on an administrator (upload or provider); the on-demand refresh and
  // the approval itself pick changes up sooner.
  awaiting_source: 30 * MINUTE,
  pending: 15 * MINUTE,
  awaiting_publication: 15 * MINUTE,
  failed: 60 * MINUTE,
  rejected: 60 * MINUTE,
  needs_review: 6 * 60 * MINUTE,
  approved: 6 * 60 * MINUTE,
};

export interface IdentityStateUpdate {
  status: VehicleImageStatus;
  reason: string | null;
  pipelineStatus: string;
  pipelineRequestId: string | null;
  imageUrl: string | null;
  imageVersion: number | null;
  catalogAssetKey: string | null;
  nextSyncAt: Date | null;
}

/** A published image is an absolute https URL with no credentials. */
export function isPublishedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      /^[\x21-\x7e]+$/.test(value)
    );
  } catch {
    return false;
  }
}

/**
 * Local state for a pipeline answer. `previous` is the stored state: a pipeline
 * that no longer knows the request (`not_found`) does not take away an image it
 * already published, because published URLs are immutable.
 */
export function stateFromPipeline(
  result: PipelineStatusResult,
  now: Date,
  previous?: {
    status: VehicleImageStatus;
    imageUrl: string | null;
    imageVersion: number | null;
    catalogAssetKey?: string | null;
  },
): IdentityStateUpdate {
  const at = (key: string): Date =>
    new Date(now.getTime() + (RESYNC_AFTER_MS[key] ?? 15 * MINUTE));
  const base = {
    pipelineStatus: result.status,
    pipelineRequestId: result.requestId,
  };
  const none = { imageUrl: null, imageVersion: null, catalogAssetKey: null };

  switch (result.status) {
    case 'approved': {
      const asset = result.asset!;
      if (!asset.url || !isPublishedUrl(asset.url)) {
        if (asset.catalogAssetKey) {
          return {
            ...base,
            status: VehicleImageStatus.APPROVED,
            reason: null,
            imageUrl: null,
            imageVersion: asset.version,
            catalogAssetKey: asset.catalogAssetKey,
            nextSyncAt: at('approved'),
          };
        }
        return {
          ...base,
          ...none,
          status: VehicleImageStatus.PENDING,
          reason: IDENTITY_REASONS.AWAITING_PUBLICATION,
          nextSyncAt: at('awaiting_publication'),
        };
      }
      return {
        ...base,
        status: VehicleImageStatus.APPROVED,
        reason: null,
        imageUrl: asset.url,
        imageVersion: asset.version,
        catalogAssetKey: null,
        nextSyncAt: at('approved'),
      };
    }
    case 'failed':
      return {
        ...base,
        ...none,
        status: VehicleImageStatus.UNAVAILABLE,
        reason: IDENTITY_REASONS.GENERATION_FAILED,
        nextSyncAt: at('failed'),
      };
    case 'rejected':
      return {
        ...base,
        ...none,
        status: VehicleImageStatus.UNAVAILABLE,
        reason: IDENTITY_REASONS.REJECTED,
        nextSyncAt: at('rejected'),
      };
    case 'not_found':
      if (
        previous?.status === VehicleImageStatus.APPROVED &&
        previous.imageUrl &&
        previous.imageVersion
      ) {
        return {
          ...base,
          status: VehicleImageStatus.APPROVED,
          reason: null,
          imageUrl: previous.imageUrl,
          imageVersion: previous.imageVersion,
          catalogAssetKey: previous.catalogAssetKey ?? null,
          nextSyncAt: at('approved'),
        };
      }
      return {
        ...base,
        ...none,
        status: VehicleImageStatus.UNAVAILABLE,
        reason: IDENTITY_REASONS.REQUEST_MISSING,
        nextSyncAt: null,
      };
    case 'needs_review':
      // Re-read now and then: an administrator can resolve the review.
      return {
        ...base,
        ...none,
        status: VehicleImageStatus.UNAVAILABLE,
        reason: IDENTITY_REASONS.IDENTITY_REVIEW_REQUIRED,
        nextSyncAt: at('needs_review'),
      };
    default:
      // queued | running | awaiting_approval | awaiting_source | pending
      return {
        ...base,
        ...none,
        status: VehicleImageStatus.PENDING,
        reason: null,
        nextSyncAt: at(result.status),
      };
  }
}

// ── Response field ────────────────────────────────────────────────────────────

export type VehicleImagePublicStatus = 'pending' | 'approved' | 'unavailable';
/**
 * Why a `pending` image is not there yet, so the app can say so honestly:
 *   processing       a job is preparing a candidate
 *   awaiting_review  a candidate waits for a person, or a person must supply one
 */
export type VehicleImagePublicStage = 'processing' | 'awaiting_review';
export type VehicleImagePublicReason =
  | 'not_requested'
  | 'needs_review'
  | 'generation_failed'
  | 'rejected'
  | 'request_failed';

export interface VehicleImageField {
  status: VehicleImagePublicStatus;
  /** Present only while `pending`. */
  stage?: VehicleImagePublicStage;
  /** Present only once the approved image is published. */
  url: string | null;
  version: number | null;
  catalog_asset_key?: string;
  /** Why the placeholder stays; null unless `unavailable`. */
  reason: VehicleImagePublicReason | null;
}

export interface VehicleImageSourceRow {
  imageReviewReason?: string | null;
  imageIdentity?: {
    status: VehicleImageStatus;
    reason: string | null;
    imageUrl: string | null;
    imageVersion: number | null;
    catalogAssetKey?: string | null;
    /** The pipeline's last status, for the pending stage. */
    pipelineStatus?: string | null;
    /** The stored canonical identity; a publication is shown only for a market-aware one. */
    identity?: unknown;
  } | null;
}

/**
 * Whether the stored identity names a verified market. Identities saved before
 * markets were resolved per vehicle carry none, so a publication made for one
 * could show another market's car (e.g. a US-market Spark); it is not shown.
 */
function hasMarket(identity: unknown): boolean {
  return (
    !!identity &&
    typeof identity === 'object' &&
    typeof (identity as { marketRegion?: unknown }).marketRegion === 'string'
  );
}

/**
 * Whether a publication of this stored identity may be shown: a market-aware
 * identity, or an unverified one (its publication is stored only once a person
 * confirmed the car, see parseStatusResult). Legacy market-less identities never.
 */
function publicationShowable(identity: unknown): boolean {
  return (
    hasMarket(identity) ||
    (!!identity &&
      typeof identity === 'object' &&
      (identity as { identityStatus?: unknown }).identityStatus === 'unverified')
  );
}

const REVIEW_STAGES = new Set(['awaiting_approval', 'awaiting_source', 'needs_review']);

const pending = (pipelineStatus: string | null | undefined): VehicleImageField => ({
  status: 'pending',
  stage: pipelineStatus && REVIEW_STAGES.has(pipelineStatus) ? 'awaiting_review' : 'processing',
  url: null,
  version: null,
  reason: null,
});

const unavailable = (reason: VehicleImagePublicReason): VehicleImageField => ({
  status: 'unavailable',
  url: null,
  version: null,
  reason,
});

/**
 * The `vehicle_image` field of Garage responses, from stored state only (no I/O).
 *
 * Shown, in this order: an approved registry image (`catalog_asset_key`, only
 * while the registry still approves that key), then an approved pipeline
 * publication of a market-aware identity. Anything else is a placeholder state.
 */
export function presentVehicleImage(
  row: VehicleImageSourceRow,
): VehicleImageField {
  const state = row.imageIdentity;
  if (state) {
    if (state.status === VehicleImageStatus.APPROVED && state.imageVersion) {
      const published =
        state.imageUrl && isPublishedUrl(state.imageUrl) ? state.imageUrl : null;
      if (state.catalogAssetKey) {
        // Approval withdrawn from the registry: never show it.
        if (!isApprovedCatalogAssetKey(state.catalogAssetKey))
          return unavailable('needs_review');
        return {
          status: 'approved',
          url: published,
          version: state.imageVersion,
          catalog_asset_key: state.catalogAssetKey,
          reason: null,
        };
      }
      if (published) {
        // A legacy, market-less publication: not shown. The app keeps its own
        // owner-approved image for the exact model, or the placeholder.
        if (!publicationShowable(state.identity)) return unavailable('not_requested');
        return {
          status: 'approved',
          url: published,
          version: state.imageVersion,
          reason: null,
        };
      }
    }
    if (state.status === VehicleImageStatus.PENDING) {
      return pending(state.pipelineStatus);
    }
    if (state.status === VehicleImageStatus.UNAVAILABLE) {
      if (state.reason === IDENTITY_REASONS.GENERATION_FAILED)
        return unavailable('generation_failed');
      if (state.reason === IDENTITY_REASONS.REJECTED)
        return unavailable('rejected');
      if (state.reason === IDENTITY_REASONS.IDENTITY_REVIEW_REQUIRED)
        return unavailable('needs_review');
      if (state.reason === IDENTITY_REASONS.NOT_REQUESTED)
        return unavailable('not_requested');
      return unavailable('request_failed');
    }
    return pending(state.pipelineStatus);
  }
  if (row.imageReviewReason) return unavailable('needs_review');
  return unavailable('not_requested');
}
