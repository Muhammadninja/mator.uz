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
import { ProductDraftService } from '../telegram/product-draft.service';

/**
 * Scheduled sweep of abandoned product drafts (the TTL mechanism from the plan).
 * Runs as a REPEATABLE job on the MAINTENANCE queue — chosen over @nestjs/schedule
 * so it survives restarts and, being delivered to a single BullMQ worker, needs no
 * scale-out lock.
 *
 * For each CREATING draft past its `expiresAt`:
 *   1. delete its Cloudinary assets (stored originals + processed results),
 *   2. remove any still-unfinished image jobs for it from the image queue,
 *   3. transition it CREATING → EXPIRED under the optimistic lock (so a draft that
 *      concurrently advanced to READY_FOR_PREVIEW is left alone).
 *
 * The repeatable job is registered once on module init with a stable jobId, so
 * repeated boots don't stack duplicate schedules.
 */
@Processor(QUEUE_NAMES.MAINTENANCE)
@Injectable()
export class DraftCleanupProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DraftCleanupProcessor.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.MAINTENANCE)
    private readonly maintenanceQueue: Queue,
    @InjectQueue(QUEUE_NAMES.IMAGE_PROCESSING)
    private readonly imageQueue: Queue,
    private readonly drafts: ProductDraftService,
    private readonly cloudinary: CloudinaryService,
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
    const expired = await this.drafts.findExpired(new Date());
    if (expired.length === 0) return;

    this.logger.log(`Sweeping ${expired.length} expired draft(s)`);
    for (const draft of expired) {
      try {
        // 1. Delete Cloudinary assets (originals + processed). Best-effort inside
        //    CloudinaryService (logs, never throws), so one bad asset can't wedge
        //    the sweep.
        const publicIds = await this.drafts.collectPublicIds(draft.id);
        if (publicIds.length > 0) await this.cloudinary.deleteAssets(publicIds);

        // 2. Remove any not-yet-finished image jobs (those still carrying a jobId
        //    whose row never reached READY/FAILED). A completed/removed job id is a
        //    harmless no-op for queue.remove.
        for (const img of draft.images) {
          if (img.jobId) {
            try {
              await this.imageQueue.remove(img.jobId);
            } catch {
              // Job already gone / active — ignore; it will age out on its own.
            }
          }
        }

        // 3. Versioned transition so we never clobber a draft that just advanced.
        const moved = await this.drafts.tryTransition(
          draft.id,
          DraftStatus.CREATING,
          DraftStatus.EXPIRED,
          draft.version,
        );
        if (!moved) {
          this.logger.debug(
            `Draft ${draft.id} changed during sweep — skipped EXPIRED transition`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Cleanup failed for draft ${draft.id}: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.logger.error(
      `Maintenance job ${job?.id ?? 'unknown'} failed: ${err.message}`,
      err.stack,
    );
  }
}
