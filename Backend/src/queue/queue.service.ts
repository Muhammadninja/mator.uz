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
  /** Message body. */
  message: string;
}

export interface NotificationJobData {
  /** Target user id. */
  userId: string;
  /** Notification type discriminator. */
  type: string;
  /** Free-form payload the eventual notifier will interpret. */
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
   * before a retry). A missing or already-active job is a harmless no-op.
   */
  async removeImageJob(jobId: string): Promise<void> {
    await this.imageQueue.remove(jobId);
  }

  /**
   * Enqueue an outbound SMS job.
   *
   * NO deterministic jobId by default: two genuinely distinct SMS to the same
   * number (e.g. two separate OTP requests) must both be delivered, so collapsing
   * on (phone) or (phone+message) would silently drop the second one. Callers
   * that DO need idempotency (a specific business event that must send at most
   * once) should pass their own stable `opts.jobId` derived from that event id.
   */
  async enqueueSms(
    data: SmsJobData,
    opts?: JobsOptions,
  ): Promise<Job<SmsJobData>> {
    this.logger.debug(`Enqueue sms job for ${data.phone}`);
    return this.smsQueue.add('send', data, opts);
  }

  /**
   * Enqueue a notification job.
   *
   * No deterministic jobId by default for the same reason as SMS — repeated
   * notifications of the same type to the same user are usually legitimately
   * distinct events. Callers with an at-most-once event should pass their own
   * `opts.jobId`.
   */
  async enqueueNotification(
    data: NotificationJobData,
    opts?: JobsOptions,
  ): Promise<Job<NotificationJobData>> {
    this.logger.debug(`Enqueue notification job for ${data.userId}`);
    return this.notificationQueue.add('notify', data, opts);
  }
}
