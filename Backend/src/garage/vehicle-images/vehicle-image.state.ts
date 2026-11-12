import { VehicleImageStatus } from '@prisma/client';
import type { PipelineStatusResult } from './vehicle-image.pipeline-client';

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
 */
export const IDENTITY_REASONS = {
  GENERATION_FAILED: 'generation_failed',
  REJECTED: 'rejected',
  DISPATCH_FAILED: 'dispatch_failed',
  REQUEST_MISSING: 'request_missing',
  AWAITING_PUBLICATION: 'awaiting_publication',
} as const;

export const REDISPATCHABLE_REASONS: ReadonlySet<string> = new Set([
  IDENTITY_REASONS.DISPATCH_FAILED,
  IDENTITY_REASONS.REQUEST_MISSING,
]);

const MINUTE = 60_000;
/** How soon the background sync looks at an identity again, by pipeline state. */
const RESYNC_AFTER_MS: Record<string, number> = {
  queued: 2 * MINUTE,
  running: 2 * MINUTE,
  awaiting_approval: 15 * MINUTE,
  pending: 15 * MINUTE,
  awaiting_publication: 15 * MINUTE,
  failed: 60 * MINUTE,
  rejected: 60 * MINUTE,
  approved: 6 * 60 * MINUTE,
};

export interface IdentityStateUpdate {
  status: VehicleImageStatus;
  reason: string | null;
  pipelineStatus: string;
  pipelineRequestId: string | null;
  imageUrl: string | null;
  imageVersion: number | null;
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
  },
): IdentityStateUpdate {
  const at = (key: string): Date =>
    new Date(now.getTime() + (RESYNC_AFTER_MS[key] ?? 15 * MINUTE));
  const base = {
    pipelineStatus: result.status,
    pipelineRequestId: result.requestId,
  };
  const none = { imageUrl: null, imageVersion: null };

  switch (result.status) {
    case 'approved': {
      const asset = result.asset!;
      if (!isPublishedUrl(asset.url)) {
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
    default:
      // queued | running | awaiting_approval | pending
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
export type VehicleImagePublicReason =
  | 'not_requested'
  | 'needs_review'
  | 'generation_failed'
  | 'rejected'
  | 'request_failed';

export interface VehicleImageField {
  status: VehicleImagePublicStatus;
  /** Present only once the approved image is published. */
  url: string | null;
  version: number | null;
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
  } | null;
}

const unavailable = (reason: VehicleImagePublicReason): VehicleImageField => ({
  status: 'unavailable',
  url: null,
  version: null,
  reason,
});

/** The `vehicle_image` field of Garage responses, from stored state only (no I/O). */
export function presentVehicleImage(
  row: VehicleImageSourceRow,
): VehicleImageField {
  const state = row.imageIdentity;
  if (state) {
    if (
      state.status === VehicleImageStatus.APPROVED &&
      state.imageUrl &&
      state.imageVersion &&
      isPublishedUrl(state.imageUrl)
    ) {
      return {
        status: 'approved',
        url: state.imageUrl,
        version: state.imageVersion,
        reason: null,
      };
    }
    if (state.status === VehicleImageStatus.PENDING) {
      return { status: 'pending', url: null, version: null, reason: null };
    }
    if (state.status === VehicleImageStatus.UNAVAILABLE) {
      if (state.reason === IDENTITY_REASONS.GENERATION_FAILED)
        return unavailable('generation_failed');
      if (state.reason === IDENTITY_REASONS.REJECTED)
        return unavailable('rejected');
      return unavailable('request_failed');
    }
    return { status: 'pending', url: null, version: null, reason: null };
  }
  if (row.imageReviewReason) return unavailable('needs_review');
  return unavailable('not_requested');
}
