import { Logger, Optional } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import axios from 'axios';
import { ImageProcessingStage } from '@prisma/client';
import {
  QUEUE_NAMES,
  resolveImageWorkerConcurrency,
  resolveSmsWorkerConcurrency,
} from './queue.constants';
import type {
  ImageJobData,
  NotificationJobData,
  SmsQueuePayload,
} from './queue.service';
import { isSmsOtpJob } from './queue.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { ImageEnhanceService } from '../ai/image-enhance.service';
import { ProductDraftService } from '../telegram/product-draft.service';
import { DraftCoordinator } from '../telegram/draft-coordinator';
import { TelegramFileService } from '../telegram/telegram-file.service';
import { DraftTelemetry, DraftMetric } from '../telegram/draft-telemetry';
import { SmsService } from '../sms/sms.service';
import { PushDispatchService } from '../notifications/push/push-dispatch.service';
import { maskPhone } from '../common/pii.util';
import { MetricsService } from '../metrics/metrics.service';
import { jobDurationSeconds } from '../metrics/job-duration.util';

/**
 * Workers (consumers), one per registered queue.
 *
 * Each extends `WorkerHost` from @nestjs/bullmq, which:
 *   • constructs a BullMQ `Worker` bound to the named queue on module init, and
 *   • registers `OnModuleDestroy` that calls `worker.close()` — so on
 *     SIGTERM/SIGINT (app.enableShutdownHooks() is already on in main.ts) every
 *     worker drains its active job and disconnects cleanly. No orphan workers.
 *
 * All three workers are now real consumers:
 *   • IMAGE         — the two-phase draft image pipeline (unchanged).
 *   • SMS           — the only caller of the SMS provider (OTP enqueues here).
 *   • NOTIFICATIONS — the push fan-out for an already-committed inbox row.
 *
 * The division of labour is the same everywhere: producers own BUSINESS STATE
 * (the OTP record in Redis, the Notification row in Postgres) and commit it
 * before enqueueing; workers own DELIVERY only and never write that state back.
 * So a job that fails, retries, or is dropped degrades delivery — it can never
 * corrupt or lose the record the user's flow depends on.
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
    private readonly telemetry: DraftTelemetry,
    // Prometheus. `@Optional()` so the existing processor unit tests, which
    // construct this class directly, keep working unchanged.
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
  }

  async process(job: Job<ImageJobData>): Promise<void> {
    const { draftId, imageId } = job.data;
    const ids = { draftId, imageId, jobId: job.id };
    const row = await this.drafts.markImageProcessing(imageId);
    this.telemetry.metric(DraftMetric.IMAGE_STARTED, ids);

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
      this.telemetry.event('image.original_stored', ids);
    }

    // ── Phase B: ENHANCE from the stored original ──
    await this.drafts.setImageStage(imageId, ImageProcessingStage.ENHANCING);
    const originalBuf = await this.download(originalUrl);
    this.telemetry.event('image.flux_started', ids);
    const cleaned = await this.imageEnhance.removeBackground(
      Buffer.from(originalBuf),
    );
    this.telemetry.event('image.flux_finished', ids);
    await this.drafts.setImageStage(
      imageId,
      ImageProcessingStage.UPLOADING_RESULT,
    );
    const processed = await this.cloudinary.uploadBuffer(cleaned);
    this.telemetry.event('image.processed_uploaded', ids);

    await this.drafts.markImageReady(
      imageId,
      processed.url,
      processed.publicId,
    );
    this.telemetry.event('image.ready', ids);
    this.telemetry.metric(DraftMetric.IMAGE_COMPLETED, ids);
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

/**
 * SmsProcessor — the ONLY place an SMS provider is invoked. Producers
 * (OtpService and any future sender) enqueue; this worker delivers.
 *
 * Delegates to `SmsService.sendSms`, which owns provider selection, the
 * provider's own internal retries, and the best-effort accounting row. Letting a
 * failure propagate is deliberate: BullMQ then applies the bounded retry policy
 * (attempts + exponential backoff from DEFAULT_JOB_OPTIONS) and, once exhausted,
 * parks the job in the failed set for inspection rather than losing it silently.
 *
 * Idempotency is the producer's job (see QueueService.otpSmsJobId): a job that
 * runs twice WOULD send twice, so at-most-once senders must supply a stable
 * jobId. Retries of a job whose provider call already succeeded are the one
 * genuine at-least-once risk here, and the OTP flow tolerates a duplicate SMS
 * far better than a missing one.
 *
 * Concurrency is intentionally low (SMS_CONCURRENCY, default 3): aggregators
 * rate-limit per account, so this doubles as a crude outbound throttle.
 */
@Processor(QUEUE_NAMES.SMS, { concurrency: resolveSmsWorkerConcurrency() })
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(
    private readonly sms: SmsService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
  }

  async process(job: Job<SmsQueuePayload>): Promise<void> {
    const data = job.data;
    this.logger.log(`Sending sms job ${job.id} to ${maskPhone(data.phone)}`);
    // Throwing here is what triggers BullMQ's retry/backoff — do not swallow.
    if (isSmsOtpJob(data)) {
      // OTP jobs carry the code + language; SmsService renders the approved
      // template. Jobs enqueued before this payload existed have no `otp` key
      // and still take the rendered-text branch below.
      await this.sms.sendOtp(data.phone, data.otp.code, data.otp.lang);
      return;
    }
    await this.sms.sendSms(data.phone, data.message, data.template ?? null);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<SmsQueuePayload>): void {
    this.logger.log(`Sms job ${job.id} completed`);
    this.metrics?.observeJob(QUEUE_NAMES.SMS, 'success', jobDurationSeconds(job));
  }

  /**
   * Fires on EVERY attempt. Only the final failure is escalated to `error` — an
   * intermediate blip is a warning, since a retry is still coming. Nothing is
   * mutated here: the OTP record in Redis is untouched by a delivery failure
   * (the code stays valid for its TTL and the user can resend), so there is no
   * business state to roll back.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<SmsQueuePayload> | undefined, err: Error): void {
    const maxAttempts = job?.opts.attempts ?? 1;
    const attemptsMade = job?.attemptsMade ?? 0;
    if (job && attemptsMade < maxAttempts) {
      this.logger.warn(
        `Sms job ${job.id} attempt ${attemptsMade}/${maxAttempts} failed: ${err.message} — retrying`,
      );
      return;
    }
    // Terminal only — see the note in ImageProcessingProcessor.onFailed.
    this.metrics?.observeJob(
      QUEUE_NAMES.SMS,
      'failure',
      jobDurationSeconds(job),
    );
    this.logger.error(
      `Sms job ${job?.id ?? 'unknown'} failed permanently: ${err.message}`,
      err.stack,
    );
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Sms job ${jobId} stalled`);
  }
}

/**
 * NotificationsProcessor — performs the PUSH fan-out for a notification whose
 * inbox row is already committed. The DB row is the source of truth and is
 * written by NotificationsService.emit before this job exists; the worker only
 * delivers, and never writes notification state.
 *
 * The preference/quiet-hours gate already ran at emit time (a suppressed
 * notification is never enqueued), so this worker deliberately does not re-check
 * it — re-evaluating on a delayed retry could suppress a push whose quiet-hours
 * window opened in the meantime, which is not the emit-time decision.
 *
 * A failure propagates so BullMQ retries with backoff; PushDispatchService is
 * itself tolerant (it prunes dead tokens and no-ops for a user with no devices),
 * so a retry is safe and at worst re-delivers to still-live tokens.
 */
@Processor(QUEUE_NAMES.NOTIFICATIONS)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly push: PushDispatchService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { userId, type, notificationId, title, body, deeplinkPath, payload } =
      job.data;
    this.logger.log(
      `Processing notification job ${job.id} (userId=${userId}, type=${type})`,
    );
    await this.push.sendToUser(userId, {
      title,
      body,
      deeplinkPath,
      // Same payload shape the inline path built, so clients see no change.
      data: {
        ...payload,
        notification_id: notificationId,
        type: type.toLowerCase(),
      },
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<NotificationJobData>): void {
    this.logger.log(`Notification job ${job.id} completed`);
    this.metrics?.observeJob(
      QUEUE_NAMES.NOTIFICATIONS,
      'success',
      jobDurationSeconds(job),
    );
  }

  /**
   * Only escalate once retries are exhausted. A permanently failed push leaves
   * the inbox row intact and unread — the user still sees the notification in
   * the app, which is why a lost push is degraded delivery, not lost data.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<NotificationJobData> | undefined, err: Error): void {
    const maxAttempts = job?.opts.attempts ?? 1;
    const attemptsMade = job?.attemptsMade ?? 0;
    if (job && attemptsMade < maxAttempts) {
      this.logger.warn(
        `Notification job ${job.id} attempt ${attemptsMade}/${maxAttempts} failed: ${err.message} — retrying`,
      );
      return;
    }
    // Terminal only — see the note in ImageProcessingProcessor.onFailed.
    this.metrics?.observeJob(
      QUEUE_NAMES.NOTIFICATIONS,
      'failure',
      jobDurationSeconds(job),
    );
    this.logger.error(
      `Notification job ${job?.id ?? 'unknown'} failed permanently (inbox row survives): ${err.message}`,
      err.stack,
    );
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Notification job ${jobId} stalled`);
  }
}
