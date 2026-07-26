import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { resolveAlertingConfig, type AlertingConfig } from './alerting.config';
import {
  ALERT_CHANNELS,
  severityName,
  type AlertChannel,
  type AlertNotification,
} from './alerting.types';

/**
 * The job payload: one notification bound to ONE channel.
 *
 * Fan-out happens at ENQUEUE time, not at delivery time — one job per
 * (notification, channel). That is what keeps a failing Slack webhook from
 * retrying the Telegram send that already succeeded: each destination gets its
 * own retry budget and its own failure record.
 */
export interface AlertDeliveryJob {
  channel: string;
  notification: AlertNotification;
}

/**
 * Enqueues alert notifications for delivery, fanning out across every
 * configured channel that accepts them.
 *
 * ── Why the queue, and not a direct send ──
 * Telegram delivery must never block alert evaluation. A direct `sendMessage`
 * inside the evaluation loop would put a third-party HTTPS call (which can hang
 * for its full timeout, or rate-limit with a 429) on the critical path of the
 * one-minute tick — so one slow destination would stall detection of every
 * OTHER condition. Enqueueing makes the evaluator's cost a Redis write per
 * channel, and hands retry/backoff to the same BullMQ policy the rest of the
 * app already relies on.
 *
 * This class is the PRODUCER only; AlertProcessor is the consumer.
 */
@Injectable()
export class AlertNotifierService {
  private readonly logger = new Logger(AlertNotifierService.name);
  private readonly config: AlertingConfig;

  constructor(
    @Inject(ALERT_CHANNELS) private readonly channels: readonly AlertChannel[],
    config: ConfigService,
    // Optional so the notifier can be unit-tested (and the module can boot in a
    // queue-less context) without a live BullMQ registration.
    @Optional()
    @InjectQueue(QUEUE_NAMES.ALERTS)
    private readonly queue?: Queue<AlertDeliveryJob>,
  ) {
    this.config = resolveAlertingConfig(config);
  }

  /**
   * Queue one notification for every channel that wants it.
   *
   * Never throws: a delivery-side problem must not propagate into the evaluator
   * and abort the remaining rules. Everything that prevents delivery is logged
   * so the transition is recorded even when nothing was sent — the log is the
   * durable record, and a channel is best-effort on top of it.
   */
  async notify(notification: AlertNotification): Promise<void> {
    const id = notification.fingerprint;

    // Log the transition FIRST and unconditionally.
    this.logger.log(
      `[${id}] Alert ${notification.state}: ${notification.dedupeKey} — ` +
        `${notification.title} [${severityName(notification.severity)}]`,
    );

    const targets = this.channels.filter(
      (channel) => channel.configured && channel.accepts(notification),
    );

    if (targets.length === 0) {
      this.logger.warn(
        `[${id}] No channel accepted alert "${notification.dedupeKey}" ` +
          `(severity ${severityName(notification.severity)}) — logged only. ` +
          `Configure ALERT_TELEGRAM_CHAT_ID / ALERT_SLACK_WEBHOOK_URL to enable delivery.`,
      );
      return;
    }

    this.logger.debug(
      `[${id}] Dispatching to ${targets.map((c) => c.name).join(', ')}`,
    );

    await Promise.all(
      targets.map((channel) => this.dispatch(channel, notification)),
    );
  }

  /** Enqueue (or, with no queue wired, deliver inline) for one channel. */
  private async dispatch(
    channel: AlertChannel,
    notification: AlertNotification,
  ): Promise<void> {
    if (this.queue === undefined) {
      await this.deliverInline(channel, notification);
      return;
    }

    try {
      await this.queue.add(
        ALERT_JOB_NAME,
        { channel: channel.name, notification },
        {
          jobId: notificationJobId(notification, channel.name),
          attempts: this.config.deliveryAttempts,
          backoff: {
            type: 'exponential',
            delay: this.config.deliveryBackoffMs,
          },
        },
      );
    } catch (err) {
      this.logger.error(
        `[${notification.fingerprint}] Failed to enqueue ` +
          `"${notification.dedupeKey}" for ${channel.name}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Last-resort direct send used only when no queue is wired (unit context). */
  private async deliverInline(
    channel: AlertChannel,
    notification: AlertNotification,
  ): Promise<void> {
    try {
      await channel.deliver(notification);
    } catch (err) {
      this.logger.error(
        `[${notification.fingerprint}] Alert notification FAILED for ` +
          `"${notification.dedupeKey}" via ${channel.name}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** The BullMQ job name on the alerts queue. */
export const ALERT_JOB_NAME = 'deliver';

/**
 * Deterministic job id: `alert_<channel>_<dedupeKey>_<state>_<firedAt>`.
 *
 * Collapses a genuine duplicate — two instances racing to announce the same
 * transition at the same instant — into one delivery per channel, while keeping
 * distinct transitions (ACTIVE then RESOLVED, or a later re-notification)
 * separate, because both `state` and `firedAt` differ between them. The channel
 * is part of the id so a Slack failure never deduplicates against the Telegram
 * job for the same alert.
 *
 * `_` rather than `:` — BullMQ rejects a custom jobId containing `:` unless it
 * splits into exactly 3 parts. `dedupeKey` also carries rendered label VALUES
 * (`rule{key="value"}`), which are not colon-free by construction, so the key is
 * additionally stripped of any `:` it may contain. Substitution is uniform, so
 * two ids collide only if they were already equal — dedup behaviour is unchanged.
 */
export function notificationJobId(
  notification: AlertNotification,
  channel: string,
): string {
  const dedupeKey = notification.dedupeKey.replace(/:/g, '_');
  return `alert_${channel}_${dedupeKey}_${notification.state}_${notification.firedAt}`;
}
