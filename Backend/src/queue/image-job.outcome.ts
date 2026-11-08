import type { Logger } from '@nestjs/common';
import type { CloudinaryService } from '../cloudinary/cloudinary.service';
import type { DraftTelemetry } from '../telegram/draft-telemetry';
import type { ProductDraftService } from '../telegram/product-draft.service';

/**
 * What an image job returns when it did no work. `already_ready`: the row was
 * READY with a result, so the job was a duplicate (see process()).
 *
 * BullMQ never runs one jobId twice at once, except when a job's lock is lost
 * (Redis unreachable or the event loop blocked past lockDuration, 30 s) and the
 * stalled-job check hands it to another run while the first is still going.
 * Both runs then read PROCESSING and both proceed — both may call FLUX. What
 * keeps that safe is the row writes (ProductDraftService): each is conditional,
 * so one run stores the original, one finalizes READY, and the other drops its
 * surplus uploads. A single DB winner, not exactly-once processing.
 */
export interface ImageJobResult {
  /** already_ready: a duplicate job; lost_race: another run finalized first. */
  skipped: 'already_ready' | 'lost_race';
}

export type DraftJobIds = { draftId: string; imageId: string; jobId?: string };

/** What these helpers need from the image worker. */
export interface SurplusAssetDeps {
  drafts: Pick<ProductDraftService, 'findImageState'>;
  cloudinary: Pick<CloudinaryService, 'deleteAssets'>;
  telemetry: Pick<DraftTelemetry, 'event'>;
  logger: Pick<Logger, 'log' | 'warn'>;
}

/**
 * Delete an asset this run uploaded but did not get to record. It is safe
 * only when the row could be read and references neither of its assets by
 * that public_id (Cloudinary gives every upload a fresh one, so a match would
 * mean it is in use after all). Otherwise it is kept and reported. Never
 * throws: a failed cleanup must not fail the job into a retry (FLUX again).
 */
export async function discardSurplusAsset(
  deps: SurplusAssetDeps,
  publicId: string,
  row: {
    originalPublicId: string | null;
    processedPublicId: string | null;
  } | null,
  kind: 'original' | 'processed',
  ids: DraftJobIds,
): Promise<void> {
  const inUse =
    !row ||
    row.originalPublicId === publicId ||
    row.processedPublicId === publicId;
  if (inUse) {
    deps.logger.warn(
      `Surplus ${kind} asset ${publicId} of image ${ids.imageId} kept: ` +
        'cannot prove it is unused',
    );
    deps.telemetry.event(`image.surplus_${kind}_kept`, ids);
    return;
  }
  try {
    await deps.cloudinary.deleteAssets([publicId]);
    deps.telemetry.event(`image.surplus_${kind}_deleted`, ids);
  } catch (err) {
    deps.logger.warn(
      `Surplus ${kind} asset ${publicId} of image ${ids.imageId} not deleted: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    deps.telemetry.event(`image.surplus_${kind}_kept`, ids);
  }
}

/**
 * Another run finalized the row (READY), or it left PROCESSING another way
 * (FAILED, gone) while this run was enhancing. Nothing is overwritten,
 * onImageSettled is not called (the winner's — or the failure's — already
 * was), and the job completes: a retry would only repeat FLUX. This run's
 * processed upload is surplus and is dropped when that is provably safe.
 */
export async function loseFinalization(
  deps: SurplusAssetDeps,
  jobId: string | undefined,
  processed: { url: string; publicId: string },
  ids: DraftJobIds,
): Promise<ImageJobResult> {
  const now = await deps.drafts.findImageState(ids.imageId).catch(() => null);
  deps.logger.warn(
    `Image job ${jobId} lost the finalization of image ${ids.imageId} ` +
      `(row is ${now?.status ?? 'unreadable'}): its result is not used`,
  );
  deps.telemetry.event('image.finalize_lost', ids);
  await discardSurplusAsset(deps, processed.publicId, now, 'processed', ids);
  return { skipped: 'lost_race' };
}

/** The row is READY with a result: this job is a duplicate and does nothing. */
export function skipDuplicate(
  deps: SurplusAssetDeps,
  jobId: string | undefined,
  ids: DraftJobIds,
): ImageJobResult {
  deps.logger.log(
    `Image job ${jobId} skipped: image ${ids.imageId} is already READY (duplicate job)`,
  );
  deps.telemetry.event('image.duplicate_skipped', ids);
  return { skipped: 'already_ready' };
}

/** The ownership token of one run: the row's `attempts` as its pickup wrote it
 *  (ProductDraftService.markImageProcessing). Unset until — unless — the run
 *  got the row; a run without one may not change it. */
export interface ImageRun {
  owner?: number;
}

const OWNER = Symbol('imageRunOwner');

/**
 * Attach the run's token to what it throws: BullMQ hands that same error to
 * the 'failed' event, which is how onFailed knows which run failed.
 */
export function tagImageRunOwner(
  err: unknown,
  owner: number | undefined,
): unknown {
  if (owner !== undefined && err !== null && typeof err === 'object') {
    Object.defineProperty(err, OWNER, { value: owner, enumerable: false });
  }
  return err;
}

/** The token of the run that threw `err`, when it had one. */
export function imageRunOwner(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const owner = (err as { [OWNER]?: unknown })[OWNER];
  return typeof owner === 'number' ? owner : undefined;
}
