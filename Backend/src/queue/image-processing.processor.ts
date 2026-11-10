import { Logger, Optional } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job, UnrecoverableError } from 'bullmq';
import axios from 'axios';
import { DraftImageStatus, ImageProcessingStage } from '@prisma/client';
import { QUEUE_NAMES, resolveImageWorkerConcurrency } from './queue.constants';
import type { ImageJobData } from './queue.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import {
  ImageEnhanceError,
  ImageEnhanceService,
} from '../ai/image-enhance.service';
import { ProductDraftService } from '../telegram/product-draft.service';
import { DraftCoordinator } from '../telegram/draft-coordinator';
import { TelegramFileService } from '../telegram/telegram-file.service';
import { DraftTelemetry, DraftMetric } from '../telegram/draft-telemetry';
import { MetricsService } from '../metrics/metrics.service';
import { jobDurationSeconds } from '../metrics/job-duration.util';
import {
  discardSurplusAsset,
  imageRunOwner,
  loseFinalization,
  skipDuplicate,
  tagImageRunOwner,
  type ImageRun,
  type ImageJobResult,
  type SurplusAssetDeps,
} from './image-job.outcome';

/** How long to wait when downloading a source/original image. */
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * ImageProcessingProcessor — the two-phase draft image pipeline (the moved FLUX
 * work). Runs OFF the seller's critical path, in parallel with the questionnaire.
 *
 * Per draft image, each phase is idempotent so BullMQ's retries are safe:
 *   • Phase A (INGEST): if the original isn't stored yet, resolve the Telegram
 *     file URL, download it, upload the ORIGINAL to Cloudinary, and persist
 *     originalUrl/originalPublicId. Skipped on any retry once originalUrl is set —
 *     so a re-run never re-touches Telegram (the short-lived file_id is only
 *     needed on the first pickup).
 *   • Phase B (ENHANCE): download the stored original, run FLUX, upload the
 *     PROCESSED result, mark the row READY. A FLUX failure that a retry would
 *     only repeat fails the job at once (UnrecoverableError) instead of using up
 *     the remaining attempts.
 * On success or terminal failure it calls DraftCoordinator.onImageSettled, which
 * evaluates the rendezvous and emits the preview/failure domain event. The worker
 * itself NEVER messages Telegram — only TelegramFileService.getFileUrl (a download).
 *
 * `stage` is advanced as the worker moves (observability only); it never gates the
 * rendezvous (that reads `status`) nor controls retry (that keys off originalUrl).
 */
// concurrency (from IMAGE_CONCURRENCY) is what makes an album's photos process in
// PARALLEL — without it BullMQ defaults to 1 and the worker drains jobs one by one.
//
// Why process.env and not ConfigService here: in @nestjs/bullmq@11 the worker's
// concurrency can ONLY be supplied through @Processor's worker-options argument.
// BullExplorer builds the Worker from `getWorkerOptionsMetadata(@Processor class)`
// and, from the queue options set via registerQueue/forRoot, reads ONLY the
// connection-related fields (connection/prefix/telemetry) — concurrency there is
// ignored. @Processor is a class decorator, evaluated at class-load time, before
// the Nest DI container (and thus ConfigService) exists — so the value must come
// from the environment directly. This is a framework constraint, not a shortcut.
@Processor(QUEUE_NAMES.IMAGE_PROCESSING, {
  concurrency: resolveImageWorkerConcurrency(),
})
export class ImageProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessingProcessor.name);

  constructor(
    private readonly drafts: ProductDraftService,
    private readonly coordinator: DraftCoordinator,
    private readonly cloudinary: CloudinaryService,
    private readonly telegramFiles: TelegramFileService,
    // The FLUX pipeline (prompt/model/params unchanged — only the call site moved
    // here). Injected so it is mockable and shares one instance app-wide.
    private readonly imageEnhance: ImageEnhanceService,
    private readonly telemetry: DraftTelemetry,
    // Prometheus. `@Optional()` so the existing processor unit tests, which
    // construct this class directly, keep working unchanged.
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
  }

  /** What the outcome helpers (image-job.outcome.ts) need from this worker. */
  private get outcomeDeps(): SurplusAssetDeps {
    return {
      drafts: this.drafts,
      cloudinary: this.cloudinary,
      telemetry: this.telemetry,
      logger: this.logger,
    };
  }

  /**
   * One run of an image job. Whatever it throws carries the run's ownership
   * token (image-job.outcome.ts), so onFailed marks FAILED only for the run
   * that still owns the row.
   */
  async process(job: Job<ImageJobData>): Promise<ImageJobResult | void> {
    const run: ImageRun = {};
    try {
      return await this.processImage(job, run);
    } catch (err) {
      throw tagImageRunOwner(err, run.owner);
    }
  }

  private async processImage(
    job: Job<ImageJobData>,
    run: ImageRun,
  ): Promise<ImageJobResult | void> {
    const { draftId, imageId } = job.data;
    const ids = { draftId, imageId, jobId: job.id };

    // ── Duplicate guard: a job for a row already READY with a result (a late
    // re-enqueue, a re-add after retention) completes as skipped and touches
    // nothing — no FLUX, no new processedUrl. Every other state runs as before.
    // Two runs that both read PROCESSING both proceed; the conditional writes
    // (ProductDraftService) then let exactly one of them win each step.
    const current = await this.drafts.findImageState(imageId);
    if (current?.status === DraftImageStatus.READY && current.processedUrl) {
      return skipDuplicate(this.outcomeDeps, job.id, ids);
    }

    // The same check, atomic: the pickup refuses a row finished meanwhile.
    const row = await this.drafts.markImageProcessing(imageId);
    if (!row) {
      if (!(await this.drafts.findImageState(imageId))) {
        throw new Error(`Image row ${imageId} not found`);
      }
      return skipDuplicate(this.outcomeDeps, job.id, ids);
    }
    // This run now owns the row; an older run still going is superseded.
    const owner = row.attempts;
    run.owner = owner;
    this.telemetry.metric(DraftMetric.IMAGE_STARTED, ids);

    // ── Phase A: INGEST original (idempotent — skipped once originalUrl is set) ──
    let originalUrl = row.originalUrl;
    if (!originalUrl) {
      await this.drafts.setImageStage(
        imageId,
        ImageProcessingStage.INGESTING_ORIGINAL,
        owner,
      );
      const fileUrl = await this.telegramFiles.getFileUrl(row.tgFileId);
      const buf = await this.download(fileUrl);
      const original = await this.cloudinary.uploadBuffer(Buffer.from(buf));
      const stored = await this.drafts.setImageOriginal(
        imageId,
        original.url,
        original.publicId,
      );
      if (stored) {
        originalUrl = original.url;
        this.telemetry.event('image.original_stored', ids);
      } else {
        // A parallel run stored its original first: use it, drop ours.
        const now = await this.drafts.findImageState(imageId);
        if (!now?.originalUrl) {
          throw new Error(`Image row ${imageId} not found`);
        }
        await discardSurplusAsset(
          this.outcomeDeps,
          original.publicId,
          now,
          'original',
          ids,
        );
        // That run may already have finished: then FLUX need not run again.
        if (now.status === DraftImageStatus.READY && now.processedUrl) {
          return skipDuplicate(this.outcomeDeps, job.id, ids);
        }
        originalUrl = now.originalUrl;
      }
    }

    // ── Phase B: ENHANCE from the stored original ──
    await this.drafts.setImageStage(
      imageId,
      ImageProcessingStage.ENHANCING,
      owner,
    );
    const originalBuf = await this.download(originalUrl);
    this.telemetry.event('image.flux_started', ids);
    const cleaned = await this.enhance(Buffer.from(originalBuf));
    this.telemetry.event('image.flux_finished', ids);
    await this.drafts.setImageStage(
      imageId,
      ImageProcessingStage.UPLOADING_RESULT,
      owner,
    );
    const processed = await this.cloudinary.uploadBuffer(cleaned);
    this.telemetry.event('image.processed_uploaded', ids);

    // ── Finalize: conditional — only the run that owns the row can win. ──
    const won = await this.drafts.markImageReady(
      imageId,
      processed.url,
      processed.publicId,
      owner,
    );
    if (!won) return loseFinalization(this.outcomeDeps, job.id, processed, ids);
    this.telemetry.event('image.ready', ids);
    this.telemetry.metric(DraftMetric.IMAGE_COMPLETED, ids);
    await this.coordinator.onImageSettled(draftId);
  }

  /**
   * Run FLUX on the original. A failure FLUX classifies as permanent (key
   * rejected, no credits, invalid request, moderated input) is rethrown as
   * UnrecoverableError, so BullMQ fails the job now rather than repeating the
   * same rejection through every remaining attempt and backoff. Anything else
   * propagates unchanged into the normal bounded retry.
   */
  private async enhance(original: Buffer): Promise<Buffer> {
    try {
      return await this.imageEnhance.removeBackground(original);
    } catch (err) {
      if (err instanceof ImageEnhanceError && !err.retryable) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  /** Download bytes to a Buffer with a bounded timeout. */
  private async download(url: string): Promise<ArrayBuffer> {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
    });
    return res.data;
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<ImageJobData>): void {
    const result = job.returnvalue as ImageJobResult | undefined;
    if (result?.skipped) {
      // Completed, but no image was processed: counted as a finished job, kept
      // out of the image-processing histogram and total.
      this.metrics?.observeJob(QUEUE_NAMES.IMAGE_PROCESSING, 'success');
      return;
    }
    this.logger.log(`Image job ${job.id} completed`);
    // Both the generic queue histogram and the business-level image histogram:
    // the former is comparable across queues, the latter is the one product
    // cares about ("how long until a seller's photo is ready?").
    const seconds = jobDurationSeconds(job);
    this.metrics?.observeJob(QUEUE_NAMES.IMAGE_PROCESSING, 'success', seconds);
    if (seconds !== undefined) {
      this.metrics?.observeImageProcessing('success', seconds);
    }
  }

  /**
   * Fires on EVERY attempt failure. We only surface the failure to the seller once
   * BullMQ has exhausted all retries — otherwise a transient blip would prematurely
   * flip the row to FAILED. On the final attempt: mark the row FAILED (stage=FAILED,
   * pinpointing where it died) and settle so the coordinator can emit images_failed.
   *
   * An UnrecoverableError is ALWAYS the final attempt: BullMQ does not retry it,
   * yet attemptsMade is still below attempts — so without that check the row
   * would wait for a retry that never comes and stay PROCESSING.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ImageJobData> | undefined,
    err: Error,
  ): Promise<void> {
    this.logger.error(
      `Image job ${job?.id ?? 'unknown'} failed: ${err.message}`,
      err.stack,
    );
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    const finalAttempt =
      job.attemptsMade >= maxAttempts || err instanceof UnrecoverableError;
    if (!finalAttempt) return; // more retries to come

    // Recorded only once retries are exhausted, so the failure counters count
    // JOBS that ultimately failed, not attempts — otherwise one flaky job with
    // 3 attempts would read as 3 failures.
    const seconds = jobDurationSeconds(job);
    this.metrics?.observeJob(QUEUE_NAMES.IMAGE_PROCESSING, 'failure', seconds);
    if (seconds !== undefined) {
      this.metrics?.observeImageProcessing('failure', seconds);
    }

    const { draftId, imageId } = job.data;
    this.telemetry.metric(DraftMetric.IMAGE_FAILED, {
      draftId,
      imageId,
      jobId: job.id,
    });
    try {
      // Only by the owner, from PROCESSING: a newer run may own the row, or
      // have finalized it READY.
      const owner = imageRunOwner(err);
      if (owner === undefined) {
        // The failed run never got an ownership token — its read or its pickup
        // failed, or BullMQ failed the job itself (a job stalled past the
        // limit). It has no right to the row: nothing is written, nothing is
        // settled, and the row stays as it is for recovery: a re-enqueue (/start)
        // gives it a new run, and DraftCleanupProcessor fails it if its job is dead.
        this.logger.warn(
          `Image ${imageId} not marked FAILED: the failed run holds no ownership token (${err.message})`,
        );
        this.telemetry.event('image.failure_unowned', {
          draftId,
          imageId,
          jobId: job.id,
        });
        return;
      }
      if (!(await this.drafts.markImageFailed(imageId, err.message, owner))) {
        this.logger.warn(
          `Image ${imageId} not marked FAILED: it is no longer PROCESSING ` +
            `or no longer owned by the failed run (${owner})`,
        );
        return;
      }
      await this.coordinator.onImageSettled(draftId);
    } catch (settleErr) {
      this.logger.error(
        `Failed to settle failed image ${imageId}: ${settleErr instanceof Error ? settleErr.message : String(settleErr)}`,
      );
    }
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Image job ${jobId} stalled`);
  }
}
