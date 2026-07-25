import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import type { MetricsConfig } from './metrics.config';
import { METRICS_CONFIG } from './metrics.providers';
import { MetricsService } from './metrics.service';

/**
 * Publishes BullMQ queue depths into the registry.
 *
 * PULL, NOT POLL. `collect()` is invoked by MetricsController when Prometheus
 * scrapes, so queue counts are read from Redis exactly as often as they are
 * actually consumed (every 15–30s) — and not at all when nobody is scraping.
 * This is the deliberate difference from QueueMonitorService in src/ops, which
 * runs its own interval because it must DETECT and ALERT on conditions between
 * scrapes. Two consumers, two access patterns, one set of underlying counts.
 *
 * Read-only with respect to the queues: `getJobCounts` and `getWorkers` only —
 * no job, payload, retry policy or workflow is touched.
 *
 * All four registered queues are injected by name from QUEUE_NAMES, mirroring
 * how OpsModule obtains the same instances (re-registration resolves the SAME
 * queues via DI; it does not create a second set and registers no processors).
 */

/** Job states sampled per queue. Mirrors what Bull Board and the monitor show. */
const SAMPLED_STATES = [
  'waiting',
  'active',
  'delayed',
  'completed',
  'failed',
  'paused',
] as const;

@Injectable()
export class QueueMetricsCollector {
  private readonly logger = new Logger(QueueMetricsCollector.name);
  private readonly queues: ReadonlyMap<string, Queue>;
  /** Log a collection failure once per queue — a scrape every 15s must not spam. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly metrics: MetricsService,
    @Inject(METRICS_CONFIG) private readonly config: MetricsConfig,
    // Optional so the collector can be constructed in a unit test (and in any
    // future queue-less deployment) without a live BullMQ registration.
    @Optional()
    @InjectQueue(QUEUE_NAMES.IMAGE_PROCESSING)
    imageQueue?: Queue,
    @Optional() @InjectQueue(QUEUE_NAMES.SMS) smsQueue?: Queue,
    @Optional()
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS)
    notificationsQueue?: Queue,
    @Optional() @InjectQueue(QUEUE_NAMES.MAINTENANCE) maintenanceQueue?: Queue,
  ) {
    const entries: [string, Queue | undefined][] = [
      [QUEUE_NAMES.IMAGE_PROCESSING, imageQueue],
      [QUEUE_NAMES.SMS, smsQueue],
      [QUEUE_NAMES.NOTIFICATIONS, notificationsQueue],
      [QUEUE_NAMES.MAINTENANCE, maintenanceQueue],
    ];
    this.queues = new Map(
      entries.filter((e): e is [string, Queue] => e[1] !== undefined),
    );
  }

  /**
   * Sample every queue and write the results into the registry gauges.
   *
   * Never throws and never rejects: a Redis hiccup during a scrape must still
   * yield a 200 with the rest of the metrics (process, HTTP, business) intact.
   * A queue that fails to sample simply keeps its previous gauge values, which
   * Prometheus renders as a flat line — visibly stale rather than a broken
   * scrape that loses everything.
   *
   * Queues are sampled in parallel so total scrape latency is one round trip,
   * not four.
   */
  async collect(): Promise<void> {
    if (!this.config.enabled || !this.config.queueMetricsEnabled) return;

    await Promise.all(
      [...this.queues.entries()].map(([name, queue]) =>
        this.collectOne(name, queue),
      ),
    );
  }

  private async collectOne(name: string, queue: Queue): Promise<void> {
    try {
      const [counts, workers] = await Promise.all([
        queue.getJobCounts(...SAMPLED_STATES),
        queue.getWorkers(),
      ]);
      this.metrics.setQueueDepths(name, counts);
      this.metrics.setQueueWorkers(name, workers.length);
      this.warned.delete(name);
    } catch (err) {
      if (!this.warned.has(name)) {
        this.warned.add(name);
        this.logger.warn(
          `Failed to collect metrics for queue "${name}" (further failures suppressed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
