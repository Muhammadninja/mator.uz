import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, type Job, type JobsOptions } from 'bullmq';
import { QUEUE_NAMES } from './queue.constants';

/**
 * Job payload shapes. These are intentionally minimal — this PR is queue
 * INFRASTRUCTURE only, so the payloads capture just enough to be a real,
 * enqueueable job without pulling in (or moving) any business logic. They will
 * grow when the actual image / SMS / notification pipelines migrate onto the
 * queues (see the migration plan in the PR description).
 */
export interface ImageJobData {
  /** The draft this image belongs to. */
  draftId: string;
  /** The ProductDraftImage row id to process (carries tgFileId, originalUrl, …). */
  imageId: string;
}

export interface SmsJobData {
  /** E.164 destination number. */
  phone: string;
  /** Message body. Rendered text — for OTP this contains the code, so it lives
   *  only in the job payload (never persisted by SmsService accounting). */
  message: string;
  /**
   * Accounting-only template label (e.g. 'otp', 'order_paid') forwarded to
   * `SmsService.sendSms`. Never the rendered text.
   */
  template?: string | null;
}

export interface NotificationJobData {
  /** Target user id. */
  userId: string;
  /** Notification type discriminator. */
  type: string;
  /**
   * The already-persisted Notification row id. The inbox row is written
   * SYNCHRONOUSLY by NotificationsService.emit (the DB is the source of truth);
   * this job only performs the push fan-out for that row, so the id doubles as
   * the natural idempotency key.
   */
  notificationId: string;
  /** Push title/body, snapshotted at emit time. */
  title: string;
  body: string;
  deeplinkPath?: string | null;
  /** Free-form data merged into the push payload. */
  payload?: Record<string, unknown>;
}

/**
 * The single injectable entry point for ENQUEUEING work. Nothing else in the app
 * touches a BullMQ `Queue` directly — producers call these typed methods so the
 * queue names, payload shapes and per-job option overrides live in one place.
 *
 * Consumption (the workers) lives in the *.processor.ts files; this class is
 * strictly the producer side.
 *
 * IMPORTANT: no business logic has been migrated yet. These methods enqueue real
 * jobs, but the corresponding workers only log — see queue.processors.ts.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.IMAGE_PROCESSING)
    private readonly imageQueue: Queue<ImageJobData>,
    @InjectQueue(QUEUE_NAMES.SMS)
    private readonly smsQueue: Queue<SmsJobData>,
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS)
    private readonly notificationQueue: Queue<NotificationJobData>,
  ) {}

  /**
   * Enqueue an image-processing job for one draft image.
   *
   * Deterministic jobId (`image:<draftId>:<imageId>`): the same draft image
   * enqueued twice — e.g. a retry that re-adds the row — collapses to a single
   * job. BullMQ ignores an add() whose jobId already exists, so this is idempotent
   * by construction and avoids double-processing the same asset.
   *
   * IMPORTANT: a FAILED job is retained (removeOnFail keeps it for days), so its
   * jobId still EXISTS in Redis — a plain add() with that id is treated as a
   * duplicate by BullMQ and does NOT re-run the work. Use `reenqueueImage` for the
   * explicit retry/recovery paths, which removes the stale job first.
   */
  async enqueueImage(
    data: ImageJobData,
    opts?: JobsOptions,
  ): Promise<Job<ImageJobData>> {
    const jobId = this.imageJobId(data);
    this.logger.debug(`Enqueue image job ${jobId}`);
    return this.imageQueue.add('process', data, { jobId, ...opts });
  }

  /**
   * Re-enqueue an image for retry/recovery. Because the deterministic jobId of a
   * previous FAILED (or leftover) attempt still EXISTS in Redis, a plain add()
   * would collapse into that existing job and silently do nothing. So this removes
   * the old job by id first, then enqueues a fresh one. Idempotent and safe when
   * there is no old job (remove is a no-op for a missing id).
   */
  async reenqueueImage(
    data: ImageJobData,
    opts?: JobsOptions,
  ): Promise<Job<ImageJobData>> {
    await this.removeImageJob(this.imageJobId(data));
    return this.enqueueImage(data, opts);
  }

  /** The deterministic image jobId: `image:<draftId>:<imageId>`. */
  imageJobId(data: ImageJobData): string {
    return `image:${data.draftId}:${data.imageId}`;
  }

  /**
   * Remove an image job by id (used when cancelling/expiring a draft so a not-yet-
   * run job doesn't process an asset we're about to delete, and by reenqueueImage
   * before a retry).
   *
   * Look the job up first and remove only if it still exists: a job that already
   * vanished on its own (retention/cleanup, or a concurrent removal) must NOT make
   * a retry/cancel throw. `job.remove()` on an ACTIVE job can still reject (BullMQ
   * won't remove a locked job); that too is swallowed — the job will finish or
   * stall-recover on its own, and the caller's intent (free the id for re-add, or
   * stop a pending job) is already satisfied for every non-active state.
   */
  async removeImageJob(jobId: string): Promise<void> {
    const job = await this.imageQueue.getJob(jobId);
    if (!job) return; // already gone — nothing to do
    try {
      await job.remove();
    } catch (err) {
      this.logger.debug(
        `removeImageJob(${jobId}) skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Enqueue an outbound SMS job.
   *
   * NO deterministic jobId by default: two genuinely distinct SMS to the same
   * number (e.g. two separate OTP requests) must both be delivered, so collapsing
   * on (phone) or (phone+message) would silently drop the second one. Callers
   * that DO need idempotency (a specific business event that must send at most
   * once) should pass their own stable `opts.jobId` derived from that event id —
   * OtpService does exactly this via {@link otpSmsJobId}, keyed on the OTP
   * request id + send attempt, so a retried HTTP request cannot double-send a
   * code while a legitimate resend (a new attempt) still goes out.
   */
  async enqueueSms(
    data: SmsJobData,
    opts?: JobsOptions,
  ): Promise<Job<SmsJobData>> {
    this.logger.debug(`Enqueue sms job for ${data.phone}`);
    return this.smsQueue.add('send', data, opts);
  }

  /**
   * Stable jobId for an OTP delivery: `sms:otp:<requestId>:<sendCount>`.
   *
   * `sendCount` (0 for the initial issue, then the resend counter) is what keeps
   * this correct in both directions: the same issue/resend enqueued twice
   * collapses to one job, while a genuine resend — which mints a NEW code and
   * bumps the counter — gets a distinct id and is delivered.
   */
  otpSmsJobId(requestId: string, sendCount: number): string {
    return `sms:otp:${requestId}:${sendCount}`;
  }

  /**
   * Enqueue a notification PUSH fan-out job.
   *
   * Deterministic jobId (`notify:<notificationId>`): the inbox row was already
   * committed by NotificationsService.emit, and one row must produce at most one
   * push fan-out. Because the id comes from that committed row it is unique per
   * real event, so this collapses accidental double-enqueues (a retried request,
   * a duplicated event handler) without ever merging two genuinely distinct
   * notifications — they have different row ids.
   */
  async enqueueNotification(
    data: NotificationJobData,
    opts?: JobsOptions,
  ): Promise<Job<NotificationJobData>> {
    const jobId = this.notificationJobId(data);
    this.logger.debug(`Enqueue notification job ${jobId}`);
    return this.notificationQueue.add('notify', data, { jobId, ...opts });
  }

  /** The deterministic notification jobId: `notify:<notificationId>`. */
  notificationJobId(data: NotificationJobData): string {
    return `notify:${data.notificationId}`;
  }
}
