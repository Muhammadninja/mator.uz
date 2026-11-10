import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { DraftStatus } from '@prisma/client';
import type { Job, Queue } from 'bullmq';
import {
  DEFAULT_DRAFT_CLEANUP_EVERY_MS,
  MAINTENANCE_JOBS,
  QUEUE_NAMES,
} from './queue.constants';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import {
  ProductDraftService,
  type DraftWithImages,
} from '../telegram/product-draft.service';
import { DraftCoordinator } from '../telegram/draft-coordinator';
import { DraftTelemetry, DraftMetric } from '../telegram/draft-telemetry';

/**
 * Scheduled sweep of abandoned product drafts (the TTL mechanism from the plan).
 * Runs as a REPEATABLE job on the MAINTENANCE queue — chosen over @nestjs/schedule
 * so it survives restarts and, being delivered to a single BullMQ worker, needs no
 * scale-out lock.
 *
 * For each draft past its `expiresAt` (CREATING; READY_FOR_PREVIEW whose preview was
 * never confirmed; COMMITTING, whose commit was interrupted before the product write):
 *   1. transition it from its CURRENT status → EXPIRED under the optimistic lock
 *      (so a draft that concurrently advanced — e.g. got published — is left alone),
 *   2. only if that succeeded, remove its unfinished image jobs and delete its assets.
 *
 * Closed drafts (CANCELLED, or EXPIRED by an earlier sweep) that still reference assets
 * are retried in their own batch, so they cannot crowd out the drafts above. Finally,
 * images left PROCESSING with no job behind them are failed (see recoverStuckImages).
 *
 * A COMMITTING draft is swept only once `expiresAt` has passed — far longer than any
 * commit takes — so this never races a commit that is genuinely in flight, and the
 * versioned transition in step 3 makes a late-finishing commit win regardless.
 *
 * PUBLISHED drafts are never selected: their processed assets are a live product's.
 *
 * The repeatable job is registered once on module init with a stable jobId, so
 * repeated boots don't stack duplicate schedules.
 */
/** Matches the default page of findClosedWithAssets. */
const CLOSED_BATCH = 100;
/** Longer than a job's retries and FLUX polling can take. */
const STUCK_IMAGE_AFTER_MS = 30 * 60 * 1000;
/** A job in one of these will never move its image on again. */
const DEAD_JOB_STATES: ReadonlySet<string> = new Set(['failed', 'completed', 'unknown']);

@Processor(QUEUE_NAMES.MAINTENANCE)
@Injectable()
export class DraftCleanupProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DraftCleanupProcessor.name);
  /** Where the last closed-draft page ended. Losing it on restart only restarts the walk. */
  private closedCursor: { expiresAt: Date; id: string } | null = null;

  constructor(
    @InjectQueue(QUEUE_NAMES.MAINTENANCE)
    private readonly maintenanceQueue: Queue,
    @InjectQueue(QUEUE_NAMES.IMAGE_PROCESSING)
    private readonly imageQueue: Queue,
    private readonly drafts: ProductDraftService,
    private readonly cloudinary: CloudinaryService,
    private readonly telemetry: DraftTelemetry,
    private readonly coordinator: DraftCoordinator,
  ) {
    super();
  }

  /** Register the hourly repeatable sweep exactly once (stable jobId). */
  async onModuleInit(): Promise<void> {
    await this.maintenanceQueue.add(
      MAINTENANCE_JOBS.DRAFT_CLEANUP,
      {},
      {
        jobId: MAINTENANCE_JOBS.DRAFT_CLEANUP,
        repeat: { every: DEFAULT_DRAFT_CLEANUP_EVERY_MS },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    this.logger.log(
      `Scheduled draft-cleanup sweep every ${DEFAULT_DRAFT_CLEANUP_EVERY_MS}ms`,
    );
  }

  async process(job: Job): Promise<void> {
    if (job.name !== MAINTENANCE_JOBS.DRAFT_CLEANUP) return;
    const now = new Date();
    await this.expireActiveDrafts(now);
    await this.reclaimClosedDrafts(now);
    await this.recoverStuckImages(now);
  }

  /**
   * The status change comes first and decides: only a draft this sweep actually moved
   * has its assets deleted. One a commit claimed first is left alone, along with the
   * URLs that commit is about to publish.
   */
  private async expireActiveDrafts(now: Date): Promise<void> {
    const expired = await this.drafts.findExpiredActive(now);
    if (expired.length === 0) return;
    this.logger.log(`Expiring ${expired.length} draft(s)`);
    for (const draft of expired) {
      try {
        const moved = await this.drafts.tryTransition(
          draft.id,
          draft.status,
          DraftStatus.EXPIRED,
          draft.version,
        );
        if (!moved) {
          this.logger.debug(`Draft ${draft.id} changed during sweep — left alone`);
          continue;
        }
        this.telemetry.event('draft.expired', {
          draftId: draft.id,
          sellerId: draft.sellerId,
        });
        this.telemetry.metric(DraftMetric.DRAFT_EXPIRED, {
          draftId: draft.id,
          sellerId: draft.sellerId,
        });
        await this.releaseAssets(draft);
      } catch (err) {
        this.logFailure(draft.id, err);
      }
    }
  }

  /** Retries deletion for closed drafts that still hold assets. */
  private async reclaimClosedDrafts(now: Date): Promise<void> {
    const closed = await this.drafts.findClosedWithAssets(now, this.closedCursor);
    // A short page means the end was reached: start again next time.
    const last = closed[closed.length - 1];
    this.closedCursor =
      closed.length === CLOSED_BATCH
        ? { expiresAt: last.expiresAt, id: last.id }
        : null;
    for (const draft of closed) {
      try {
        await this.releaseAssets(draft);
      } catch (err) {
        this.logFailure(draft.id, err);
      }
    }
  }

  /**
   * Only references to assets confirmed gone are cleared, so a failed deletion leaves
   * the draft in the retry set with its status unchanged.
   */
  private async releaseAssets(draft: DraftWithImages): Promise<void> {
    for (const img of draft.images) {
      if (img.jobId) {
        try {
          await this.imageQueue.remove(img.jobId);
        } catch {
          // Job already gone or active; it ages out on its own.
        }
      }
    }
    const publicIds = await this.drafts.collectPublicIds(draft.id);
    const failed =
      publicIds.length > 0 ? await this.cloudinary.destroyAssets(publicIds) : [];
    await this.drafts.clearAssetReferences(draft.id, failed);
  }

  /**
   * A worker that dies can leave an image PROCESSING with no job left to finish it, and
   * the seller waiting forever. A job still queued or running is left to BullMQ, which
   * re-delivers stalled ones. The write is fenced on the attempt read here, so a run
   * that picked the image up meanwhile keeps it.
   */
  private async recoverStuckImages(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - STUCK_IMAGE_AFTER_MS);
    const images = await this.drafts.findStuckImages(cutoff);
    for (const image of images) {
      try {
        const job = image.jobId ? await this.imageQueue.getJob(image.jobId) : null;
        const state = job ? await job.getState() : null;
        if (state && !DEAD_JOB_STATES.has(state)) continue;
        const marked = await this.drafts.markImageFailed(
          image.id,
          'Processing was interrupted',
          image.attempts,
        );
        if (marked) await this.coordinator.onImageSettled(image.draftId);
      } catch (err) {
        this.logFailure(image.draftId, err);
      }
    }
  }

  private logFailure(draftId: string, err: unknown): void {
    this.logger.error(
      `Cleanup failed for draft ${draftId}: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.logger.error(
      `Maintenance job ${job?.id ?? 'unknown'} failed: ${err.message}`,
      err.stack,
    );
  }
}
