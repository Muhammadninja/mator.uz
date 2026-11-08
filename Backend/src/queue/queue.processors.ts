import { Logger, Optional } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job } from 'bullmq';
import { QUEUE_NAMES, resolveSmsWorkerConcurrency } from './queue.constants';
import type { NotificationJobData, SmsQueuePayload } from './queue.service';
import { isSmsOtpJob } from './queue.service';
import { SmsService } from '../sms/sms.service';
import { PushDispatchService } from '../notifications/push/push-dispatch.service';
import { maskPhone } from '../common/pii.util';
import { MetricsService } from '../metrics/metrics.service';
import { jobDurationSeconds } from '../metrics/job-duration.util';

// The image pipeline lives in its own file; re-exported so importers of this
// module (QueueModule, the specs) are unchanged.
export { ImageProcessingProcessor } from './image-processing.processor';
export type { ImageJobResult } from './image-job.outcome';

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
