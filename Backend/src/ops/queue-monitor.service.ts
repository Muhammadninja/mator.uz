import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { AlertService } from './alert.service';
import { ALERT_TYPES, type Alert, type AlertSeverity } from './alert.types';
import {
  resolveQueueMonitorConfig,
  type QueueMonitorConfig,
} from './ops.config';

/** One queue's sampled counts plus its worker count. */
export interface QueueSample {
  queue: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  /** Number of workers currently attached to this queue. */
  workers: number;
}

/** Per-queue history the growth detector needs between samples. */
interface QueueHistory {
  lastWaiting: number;
  /** Consecutive samples where `waiting` strictly increased. */
  growthStreak: number;
}

/**
 * Lightweight queue health monitor.
 *
 * Samples every registered queue on a fixed interval and raises alerts through
 * AlertService. It is READ-ONLY with respect to the queues: it calls only
 * `getJobCounts` and `getWorkers`, never touching jobs, payloads or retry
 * behaviour — no business logic is affected by it running or not running.
 *
 * Detected conditions:
 *   • FAILED_JOBS       — failed count ≥ QUEUE_ALERT_FAILED_THRESHOLD.
 *   • WAITING_GROWING   — `waiting` strictly grew on N consecutive samples AND
 *                         is above QUEUE_ALERT_WAITING_THRESHOLD. Requiring both
 *                         a floor and a sustained trend is what separates a real
 *                         backlog from a normal traffic burst that drains.
 *   • NO_ACTIVE_WORKERS — jobs are waiting but zero workers are attached, i.e.
 *                         work keeps arriving with nothing to consume it. This is
 *                         the "workers stopped" case and is CRITICAL: unlike a
 *                         backlog it never self-heals.
 *
 * Uses a plain `setInterval` rather than @nestjs/schedule's @Interval so the
 * period stays env-configurable at runtime (decorator metadata is fixed at
 * class-load time), and `.unref()` so a pending tick never holds the process open
 * during shutdown.
 */
@Injectable()
export class QueueMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueMonitorService.name);
  private readonly config: QueueMonitorConfig;
  private readonly queues: ReadonlyMap<string, Queue>;
  private readonly history = new Map<string, QueueHistory>();
  private timer?: NodeJS.Timeout;

  constructor(
    config: ConfigService,
    private readonly alerts: AlertService,
    @InjectQueue(QUEUE_NAMES.IMAGE_PROCESSING) imageQueue: Queue,
    @InjectQueue(QUEUE_NAMES.SMS) smsQueue: Queue,
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS) notificationsQueue: Queue,
    @InjectQueue(QUEUE_NAMES.MAINTENANCE) maintenanceQueue: Queue,
  ) {
    this.config = resolveQueueMonitorConfig(config);
    this.queues = new Map<string, Queue>([
      [QUEUE_NAMES.IMAGE_PROCESSING, imageQueue],
      [QUEUE_NAMES.SMS, smsQueue],
      [QUEUE_NAMES.NOTIFICATIONS, notificationsQueue],
      [QUEUE_NAMES.MAINTENANCE, maintenanceQueue],
    ]);
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.log(
        'Queue monitoring disabled (QUEUE_MONITOR_ENABLED=false)',
      );
      return;
    }
    const periodMs = this.config.intervalSec * 1000;
    this.timer = setInterval(() => {
      void this.sweep();
    }, periodMs);
    // Don't keep the event loop alive for a monitoring tick.
    this.timer.unref();
    this.logger.log(
      `Queue monitoring every ${this.config.intervalSec}s ` +
        `(failed≥${this.config.failedThreshold}, waiting≥${this.config.waitingThreshold} ` +
        `for ${this.config.waitingGrowthSamples} samples)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Sample every queue and evaluate its health. Public so it can be triggered
   * directly — by the health endpoint and by tests — without waiting for a tick.
   */
  async sweep(): Promise<QueueSample[]> {
    const samples: QueueSample[] = [];

    for (const [name, queue] of this.queues) {
      try {
        const sample = await this.sampleQueue(name, queue);
        samples.push(sample);
        await this.evaluate(sample);
      } catch (err) {
        // A Redis hiccup must not kill the interval — report and keep sampling
        // the remaining queues.
        await this.raise(
          ALERT_TYPES.MONITOR_ERROR,
          'warning',
          name,
          `Failed to sample queue: ${err instanceof Error ? err.message : String(err)}`,
          {},
        );
      }
    }

    return samples;
  }

  /** Read counts and worker count for one queue. */
  private async sampleQueue(name: string, queue: Queue): Promise<QueueSample> {
    const [counts, workers] = await Promise.all([
      queue.getJobCounts('waiting', 'active', 'failed', 'delayed'),
      queue.getWorkers(),
    ]);

    return {
      queue: name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      workers: workers.length,
    };
  }

  /** Apply the detection rules to one sample. */
  private async evaluate(sample: QueueSample): Promise<void> {
    await this.checkFailed(sample);
    await this.checkWorkers(sample);
    await this.checkWaitingGrowth(sample);
  }

  private async checkFailed(sample: QueueSample): Promise<void> {
    const base = { type: ALERT_TYPES.FAILED_JOBS, queue: sample.queue };
    if (sample.failed < this.config.failedThreshold) {
      // Recovered (or never tripped) — reopen the alert for the next occurrence.
      this.alerts.resolve(base);
      return;
    }
    await this.raise(
      ALERT_TYPES.FAILED_JOBS,
      'warning',
      sample.queue,
      `${sample.failed} failed jobs (threshold ${this.config.failedThreshold})`,
      { failed: sample.failed, threshold: this.config.failedThreshold },
    );
  }

  /**
   * Workers stopped while jobs keep arriving. Only meaningful when there is
   * pending work: a queue that is idle with no workers is normal (e.g. an
   * API-only instance that produces but doesn't consume).
   */
  private async checkWorkers(sample: QueueSample): Promise<void> {
    const base = { type: ALERT_TYPES.NO_ACTIVE_WORKERS, queue: sample.queue };
    const pending = sample.waiting + sample.active;
    if (sample.workers > 0 || pending === 0) {
      this.alerts.resolve(base);
      return;
    }
    await this.raise(
      ALERT_TYPES.NO_ACTIVE_WORKERS,
      'critical',
      sample.queue,
      `No workers attached but ${pending} job(s) pending — queue is not being consumed`,
      { waiting: sample.waiting, active: sample.active, workers: 0 },
    );
  }

  /**
   * Sustained backlog growth. Requires BOTH a strictly increasing `waiting`
   * across N consecutive samples and an absolute floor, so a burst that drains
   * normally never pages anyone.
   */
  private async checkWaitingGrowth(sample: QueueSample): Promise<void> {
    const previous = this.history.get(sample.queue);
    const growing =
      previous !== undefined && sample.waiting > previous.lastWaiting;
    const streak = growing ? (previous?.growthStreak ?? 0) + 1 : 0;

    this.history.set(sample.queue, {
      lastWaiting: sample.waiting,
      growthStreak: streak,
    });

    const base = { type: ALERT_TYPES.WAITING_GROWING, queue: sample.queue };
    const tripped =
      streak >= this.config.waitingGrowthSamples &&
      sample.waiting >= this.config.waitingThreshold;

    if (!tripped) {
      // Only clear the cooldown once the backlog actually stops growing —
      // otherwise a still-growing queue below the streak would reset its own
      // suppression window every sample and alert on every tick.
      if (!growing) this.alerts.resolve(base);
      return;
    }

    await this.raise(
      ALERT_TYPES.WAITING_GROWING,
      'warning',
      sample.queue,
      `Waiting jobs growing for ${streak} consecutive samples (now ${sample.waiting})`,
      {
        waiting: sample.waiting,
        growthStreak: streak,
        threshold: this.config.waitingThreshold,
        workers: sample.workers,
        active: sample.active,
      },
    );
  }

  /** Build and dispatch an alert. */
  private async raise(
    type: Alert['type'],
    severity: AlertSeverity,
    queue: string,
    message: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.alerts.raise({
      type,
      severity,
      queue,
      message,
      context,
      firedAt: new Date(),
    });
  }
}
