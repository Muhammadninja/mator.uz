import { Inject, Logger, Optional } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { MetricsService } from '../metrics/metrics.service';
import { jobDurationSeconds } from '../metrics/job-duration.util';
import type { OrderNotice } from '../orders/order-notices';
import type { AlertDeliveryJob } from './alert-notifier.service';
import { ALERT_CHANNELS, type AlertChannel } from './alerting.types';
import {
  ORDER_NOTICE_JOB,
  OrderNoticeService,
} from './orders/order-notice.service';

/** What travels on the alerts queue: alert deliveries, and order notices. */
type AlertQueueJob = AlertDeliveryJob | OrderNotice;

function isOrderNoticeJob(job: Job<AlertQueueJob>): job is Job<OrderNotice> {
  return job.name === ORDER_NOTICE_JOB;
}

/**
 * The worker that actually delivers an alert to its channel.
 *
 * Concurrency is left at BullMQ's default of 1 — deliberately. Alerts are
 * low-volume and ORDER MATTERS: an "ACTIVE" that overtook its own "RESOLVED"
 * would leave the channel showing a resolved incident as still firing. Serial
 * delivery makes that impossible without any coordination.
 *
 * Each job names ONE channel (fan-out happened at enqueue time), so a failing
 * Slack webhook retries on its own budget without re-sending the Telegram
 * message that already succeeded.
 *
 * Failure propagates so BullMQ applies the configured retry/backoff
 * (ALERT_DELIVERY_ATTEMPTS / ALERT_DELIVERY_BACKOFF_MS). Delivery is the only
 * thing retried: the alert's STATE was already committed by the evaluator
 * before this job existed, so a send that never succeeds degrades notification
 * — it can never corrupt the ACTIVE/RESOLVED bookkeeping.
 *
 * Order notices (ORDER_NOTICE_JOB, see orders/order-notice.service.ts) ride the same
 * queue and worker: they go to the same operators through the same bot, and are as few
 * as orders are. Every Telegram call here is bounded (channels/telegram-send.ts), so
 * neither kind can hold the other up for long.
 */
@Processor(QUEUE_NAMES.ALERTS)
export class AlertProcessor extends WorkerHost {
  private readonly logger = new Logger(AlertProcessor.name);
  private readonly byName: ReadonlyMap<string, AlertChannel>;

  constructor(
    @Inject(ALERT_CHANNELS) channels: readonly AlertChannel[],
    private readonly orderNotices: OrderNoticeService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
    this.byName = new Map(channels.map((channel) => [channel.name, channel]));
  }

  async process(job: Job<AlertQueueJob>): Promise<void> {
    if (isOrderNoticeJob(job)) {
      // Throwing is what triggers BullMQ's retry/backoff — do not swallow.
      await this.orderNotices.deliver(job.data);
      return;
    }
    const { channel: channelName, notification } = (
      job as Job<AlertDeliveryJob>
    ).data;
    const channel = this.byName.get(channelName);

    if (channel === undefined) {
      // The channel was removed or renamed between enqueue and delivery (a
      // deploy mid-flight). Retrying cannot help, so this fails terminally
      // rather than burning the whole backoff budget on a job that can never
      // succeed.
      this.logger.error(
        `[${notification.fingerprint}] Unknown alert channel "${channelName}" ` +
          `for ${notification.dedupeKey} — dropping`,
      );
      // `discard()` marks the job so BullMQ will not retry it. It is
      // synchronous in bullmq@5 — no await. Returning normally then completes
      // the job rather than burning the whole backoff budget on work that can
      // never succeed.
      job.discard();
      return;
    }

    this.logger.debug(
      `[${notification.fingerprint}] Delivering ${notification.dedupeKey} ` +
        `(${notification.state}) via ${channelName}, job ${job.id}`,
    );
    // Throwing is what triggers BullMQ's retry/backoff — do not swallow.
    await channel.deliver(notification);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<AlertQueueJob>): void {
    if (isOrderNoticeJob(job)) {
      // OrderNoticeService logs what it did (sent, or dropped and why).
      this.metrics?.observeJob(
        QUEUE_NAMES.ALERTS,
        'success',
        jobDurationSeconds(job),
      );
      return;
    }
    const { notification, channel } = (job as Job<AlertDeliveryJob>).data;
    this.logger.log(
      `[${notification.fingerprint}] Alert notification sent: ` +
        `${notification.dedupeKey} (${notification.state}) ` +
        `via ${channel}`,
    );
    this.metrics?.observeJob(
      QUEUE_NAMES.ALERTS,
      'success',
      jobDurationSeconds(job),
    );
  }

  /**
   * Fires on EVERY attempt. Only the terminal failure escalates to `error`; an
   * intermediate one is a warning because a retry is still coming — the same
   * convention the SMS and notification workers use.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<AlertQueueJob> | undefined, err: Error): void {
    if (job && isOrderNoticeJob(job)) {
      this.onOrderNoticeFailed(job, err);
      return;
    }
    const alertJob = job as Job<AlertDeliveryJob> | undefined;
    this.onAlertFailed(alertJob, err);
  }

  /**
   * An order notice attempt failed. Terminal when the attempts are spent, or when the
   * service gave up for good (UnrecoverableError: Telegram refused the request), where
   * BullMQ does not retry however many attempts are left.
   */
  private onOrderNoticeFailed(job: Job<OrderNotice>, err: Error): void {
    const maxAttempts = job.opts.attempts ?? 1;
    const what = `Order ${job.data.orderId}: ${job.data.trigger} notice`;
    const permanent = err.name === 'UnrecoverableError';
    if (!permanent && job.attemptsMade < maxAttempts) {
      this.logger.warn(
        `${what} attempt ${job.attemptsMade}/${maxAttempts} failed: ${err.message} — retrying`,
      );
      return;
    }
    this.metrics?.observeJob(
      QUEUE_NAMES.ALERTS,
      'failure',
      jobDurationSeconds(job),
    );
    this.logger.error(
      `${what} FAILED permanently after ${job.attemptsMade} attempt(s): ${err.message}`,
      err.stack,
    );
  }

  private onAlertFailed(
    job: Job<AlertDeliveryJob> | undefined,
    err: Error,
  ): void {
    const maxAttempts = job?.opts.attempts ?? 1;
    const attemptsMade = job?.attemptsMade ?? 0;
    const key = job?.data?.notification?.dedupeKey ?? 'unknown';
    const channel = job?.data?.channel ?? 'unknown';
    const id = job?.data?.notification?.fingerprint ?? '------';

    if (job && attemptsMade < maxAttempts) {
      this.logger.warn(
        `[${id}] Alert "${key}" via ${channel} attempt ` +
          `${attemptsMade}/${maxAttempts} failed: ${err.message} — retrying`,
      );
      return;
    }

    this.metrics?.observeJob(
      QUEUE_NAMES.ALERTS,
      'failure',
      jobDurationSeconds(job),
    );
    // The condition is still recorded in the logs and in Redis state; only the
    // message on this one channel was lost.
    this.logger.error(
      `[${id}] Alert notification FAILED permanently for "${key}" ` +
        `via ${channel}: ${err.message}`,
      err.stack,
    );
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Alert notification job ${jobId} stalled`);
  }
}
