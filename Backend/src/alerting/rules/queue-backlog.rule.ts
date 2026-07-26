import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import {
  resolveAlertingConfig,
  type BacklogQueueName,
  type QueueThresholds,
} from '../alerting.config';
import {
  AlertSeverity,
  NO_ALERTS,
  type AlertLabels,
  type AlertPayload,
  type AlertRule,
  type AlertValues,
  type RuleResult,
} from '../alerting.types';

/**
 * Alerts when a queue's WAITING job count exceeds its configured threshold.
 *
 * One alert instance per queue (`queue_backlog:<queue>`), so a backlog on
 * `image-processing` neither suppresses nor resolves one on `sms`. Thresholds
 * are per-queue because healthy depths differ by an order of magnitude between
 * a slow image pipeline and a sub-second SMS send — see alerting.config.ts.
 *
 * Read-only with respect to the queues: `getJobCounts('waiting')` only. No job,
 * payload, retry policy or workflow is touched by this rule running.
 *
 * Severity is `critical` at twice the threshold: a queue at 2× is no longer
 * absorbing a burst, it is not draining at all.
 */

/** Multiple of the threshold at which a backlog escalates to critical. */
const CRITICAL_MULTIPLIER = 2;

@Injectable()
export class QueueBacklogRule implements AlertRule {
  readonly name = 'queue_backlog';

  /**
   * The BullMQ dashboard, pre-filtered to the queue that actually backed up via
   * its `queue` template variable. Without the `{{queue}}` substitution this
   * would land on a multi-queue overview the operator has to filter by hand —
   * exactly the step the link exists to remove.
   *
   * Relative: joined onto ALERT_GRAFANA_BASE_URL, so the same code points at
   * staging Grafana in staging and production Grafana in production.
   */
  readonly dashboardUrl = '/d/mator-bullmq?var-queue={{queue}}';

  private readonly logger = new Logger(QueueBacklogRule.name);
  private readonly thresholds: QueueThresholds;
  private readonly queues: ReadonlyMap<BacklogQueueName, Queue>;

  constructor(
    config: ConfigService,
    // Optional so the rule can be constructed in a unit test without a live
    // BullMQ registration — the same pattern QueueMetricsCollector uses.
    @Optional()
    @InjectQueue(QUEUE_NAMES.IMAGE_PROCESSING)
    imageQueue?: Queue,
    @Optional() @InjectQueue(QUEUE_NAMES.SMS) smsQueue?: Queue,
    @Optional()
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS)
    notificationsQueue?: Queue,
    @Optional() @InjectQueue(QUEUE_NAMES.MAINTENANCE) maintenanceQueue?: Queue,
  ) {
    this.thresholds = resolveAlertingConfig(config).queueThresholds;

    const entries: [BacklogQueueName, Queue | undefined][] = [
      [QUEUE_NAMES.IMAGE_PROCESSING, imageQueue],
      [QUEUE_NAMES.SMS, smsQueue],
      [QUEUE_NAMES.NOTIFICATIONS, notificationsQueue],
      [QUEUE_NAMES.MAINTENANCE, maintenanceQueue],
    ];

    this.queues = new Map(
      entries.filter(
        (entry): entry is [BacklogQueueName, Queue] => entry[1] != null,
      ),
    );
  }

  async evaluate(): Promise<RuleResult> {
    if (this.queues.size === 0) return NO_ALERTS;

    const results = await Promise.all(
      [...this.queues].map(([name, queue]) => this.checkQueue(name, queue)),
    );

    return { firing: results.filter((r): r is AlertPayload => r !== null) };
  }

  /**
   * Sample one queue's waiting depth.
   *
   * Returns null both when healthy and when the sample FAILED. A Redis hiccup
   * must not be reported as "backlog resolved" — returning null leaves an
   * already-active alert to be resolved by the evaluator only if the queue is
   * genuinely readable and healthy on a later run. Redis being unreachable is
   * itself covered by the dedicated health rule, so the condition is never lost.
   */
  private async checkQueue(
    name: BacklogQueueName,
    queue: Queue,
  ): Promise<AlertPayload | null> {
    let waiting: number;
    try {
      const counts = await queue.getJobCounts('waiting');
      waiting = counts.waiting ?? 0;
    } catch (err) {
      this.logger.warn(
        `Could not sample queue "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    const threshold = this.thresholds[name];
    if (waiting <= threshold) return null;

    return {
      rule: this.name,
      // ERROR at the threshold, CRITICAL at twice it: a queue at 2× is no
      // longer absorbing a burst, it is not draining at all.
      severity:
        waiting >= threshold * CRITICAL_MULTIPLIER
          ? AlertSeverity.CRITICAL
          : AlertSeverity.ERROR,
      labels: { queue: name },
      values: { waiting, threshold },
      title: `${queueLabel(name)} Queue Backlog`,
      summary: `${queueLabel(name)} queue backlog`,
    };
  }

  /**
   * Re-read the queue when its alert resolves, so the message reports the
   * CURRENT depth ("Current: 18") rather than echoing the value that tripped
   * it ("Current: 186") — which would contradict the word "Resolved".
   */
  async resolvedValuesFor(
    labels: AlertLabels,
  ): Promise<AlertValues | undefined> {
    const name = labels.queue as BacklogQueueName | undefined;
    const queue = name ? this.queues.get(name) : undefined;
    if (name === undefined || queue === undefined) return undefined;

    try {
      const counts = await queue.getJobCounts('waiting');
      return {
        current: counts.waiting ?? 0,
        threshold: this.thresholds[name],
      };
    } catch {
      // Falling back to the cached firing values is better than failing the
      // resolution — the alert still clears, it just carries less detail.
      return undefined;
    }
  }
}

/** `image-processing` → `Image Processing`, for the message title. */
export function queueLabel(queue: string): string {
  return queue
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
