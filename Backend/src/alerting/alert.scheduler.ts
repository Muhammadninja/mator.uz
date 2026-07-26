import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertEvaluatorService } from './alert-evaluator.service';
import { resolveAlertingConfig, type AlertingConfig } from './alerting.config';

/**
 * Drives alert evaluation on a fixed cadence (ALERTING_INTERVAL_SEC, default
 * 60s — the brief's "every minute").
 *
 * ── Why setInterval and not @Cron/@Interval ──
 * @nestjs/schedule's decorators fix their period in metadata at CLASS-LOAD
 * time, before DI exists, so the interval could not be read from config —
 * changing the cadence would require a code change and a deploy. QueueMonitor-
 * Service in src/ops already made this exact trade-off for the same reason;
 * this follows it so both schedulers behave identically. ScheduleModule is
 * still registered app-wide and used by RetentionService, whose daily cron is
 * genuinely fixed.
 *
 * The timer is `unref()`d so a pending tick never holds the process open during
 * shutdown, and runs are guarded against overlap: if an evaluation is somehow
 * still running when the next tick arrives (a hung probe under its timeout),
 * the tick is SKIPPED rather than queued, so a slow dependency cannot pile up
 * concurrent evaluations.
 */
@Injectable()
export class AlertScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertScheduler.name);
  private readonly config: AlertingConfig;
  private timer?: NodeJS.Timeout;
  /** True while an evaluation is in flight — the overlap guard. */
  private running = false;

  constructor(
    private readonly evaluator: AlertEvaluatorService,
    config: ConfigService,
  ) {
    this.config = resolveAlertingConfig(config);
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.log('Alerting disabled (ALERTING_ENABLED=false)');
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.intervalSec * 1000);
    this.timer.unref();

    this.logger.log(
      `Alert evaluation every ${this.config.intervalSec}s ` +
        `(window ${this.config.rateWindowMin}min, ` +
        `image p95 > ${this.config.imageP95ThresholdSec}s, ` +
        `sms failures > ${this.config.smsFailureThreshold})`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One scheduled evaluation, with the overlap guard. Public so a test (or a
   * future admin "evaluate now" endpoint) can trigger a run directly.
   */
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        'Previous alert evaluation still running — skipping this tick',
      );
      return;
    }

    this.running = true;
    try {
      // AlertEvaluatorService.evaluate never throws; this try/finally exists to
      // guarantee the guard is released even if that contract is ever broken.
      await this.evaluator.evaluate();
    } finally {
      this.running = false;
    }
  }
}
