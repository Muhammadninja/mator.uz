import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import axios from 'axios';
import { ImageProcessingStage } from '@prisma/client';
import {
  QUEUE_NAMES,
  resolveImageWorkerConcurrency,
} from './queue.constants';
import type {
  ImageJobData,
  NotificationJobData,
  SmsJobData,
} from './queue.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { ImageEnhanceService } from '../ai/image-enhance.service';
import { ProductDraftService } from '../telegram/product-draft.service';
import { DraftCoordinator } from '../telegram/draft-coordinator';
import { TelegramFileService } from '../telegram/telegram-file.service';

/**
 * Workers (consumers), one per registered queue.
 *
 * Each extends `WorkerHost` from @nestjs/bullmq, which:
 *   • constructs a BullMQ `Worker` bound to the named queue on module init, and
 *   • registers `OnModuleDestroy` that calls `worker.close()` — so on
 *     SIGTERM/SIGINT (app.enableShutdownHooks() is already on in main.ts) every
 *     worker drains its active job and disconnects cleanly. No orphan workers.
 *
 * The SMS/Notification workers are still placeholders (they only log); their real
 * pipelines migrate later. The IMAGE worker below is the real, two-phase draft
 * image pipeline.
 */

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
 *   • Phase B (ENHANCE): download the stored original, run FLUX (unchanged), upload
 *     the PROCESSED result, mark the row READY.
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
  ) {
    super();
  }

  async process(job: Job<ImageJobData>): Promise<void> {
    const { draftId, imageId } = job.data;
    const row = await this.drafts.markImageProcessing(imageId);

    // ── Phase A: INGEST original (idempotent — skipped once originalUrl is set) ──
    let originalUrl = row.originalUrl;
    if (!originalUrl) {
      await this.drafts.setImageStage(
        imageId,
        ImageProcessingStage.INGESTING_ORIGINAL,
      );
      const fileUrl = await this.telegramFiles.getFileUrl(row.tgFileId);
      const buf = await this.download(fileUrl);
      const original = await this.cloudinary.uploadBuffer(Buffer.from(buf));
      await this.drafts.setImageOriginal(
        imageId,
        original.url,
        original.publicId,
      );
      originalUrl = original.url;
    }

    // ── Phase B: ENHANCE from the stored original ──
    await this.drafts.setImageStage(imageId, ImageProcessingStage.ENHANCING);
    const originalBuf = await this.download(originalUrl);
    const cleaned = await this.imageEnhance.removeBackground(
      Buffer.from(originalBuf),
    );
    await this.drafts.setImageStage(
      imageId,
      ImageProcessingStage.UPLOADING_RESULT,
    );
    const processed = await this.cloudinary.uploadBuffer(cleaned);

    await this.drafts.markImageReady(
      imageId,
      processed.url,
      processed.publicId,
    );
    await this.coordinator.onImageSettled(draftId);
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
    this.logger.log(`Image job ${job.id} completed`);
  }

  /**
   * Fires on EVERY attempt failure. We only surface the failure to the seller once
   * BullMQ has exhausted all retries — otherwise a transient blip would prematurely
   * flip the row to FAILED. On the final attempt: mark the row FAILED (stage=FAILED,
   * pinpointing where it died) and settle so the coordinator can emit images_failed.
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
    if (job.attemptsMade < maxAttempts) return; // more retries to come

    const { draftId, imageId } = job.data;
    try {
      await this.drafts.markImageFailed(imageId, err.message);
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

@Processor(QUEUE_NAMES.SMS)
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);

  process(job: Job<SmsJobData>): Promise<void> {
    // Placeholder: real SMS sending is NOT wired in yet (OTP/SMS still send
    // inline). Real impl will await the provider call; nothing to await now.
    this.logger.log(`Processing sms job ${job.id} (phone=${job.data.phone})`);
    return Promise.resolve();
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<SmsJobData>): void {
    this.logger.log(`Sms job ${job.id} completed`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SmsJobData> | undefined, err: Error): void {
    this.logger.error(
      `Sms job ${job?.id ?? 'unknown'} failed: ${err.message}`,
      err.stack,
    );
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Sms job ${jobId} stalled`);
  }
}

@Processor(QUEUE_NAMES.NOTIFICATIONS)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  process(job: Job<NotificationJobData>): Promise<void> {
    // Placeholder: real notification fan-out is NOT wired in yet. Real impl will
    // await the fan-out; nothing to await now.
    this.logger.log(
      `Processing notification job ${job.id} (userId=${job.data.userId}, type=${job.data.type})`,
    );
    return Promise.resolve();
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<NotificationJobData>): void {
    this.logger.log(`Notification job ${job.id} completed`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<NotificationJobData> | undefined, err: Error): void {
    this.logger.error(
      `Notification job ${job?.id ?? 'unknown'} failed: ${err.message}`,
      err.stack,
    );
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Notification job ${jobId} stalled`);
  }
}
