import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertService } from '../ops/alert.service';
import type {
  Alert,
  AlertChannel as OpsAlertChannel,
  AlertSeverity as OpsAlertSeverity,
} from '../ops/alert.types';
import { AlertNotifierService } from './alert-notifier.service';
import { resolveAlertingConfig } from './alerting.config';
import { ALERT_SOURCE } from './build-info';
import {
  ALERT_STATE,
  AlertSeverity,
  alertDedupeKey,
  alertFingerprint,
  type AlertLabels,
  type AlertSource,
  type AlertValues,
} from './alerting.types';

/**
 * Routes the EXISTING queue-monitor alerts (src/ops) into this module's
 * delivery path, so they reach Telegram instead of only the log.
 *
 * ── Why bridge rather than reimplement ──
 * QueueMonitorService already detects three conditions this module does not:
 * FAILED_JOBS, WAITING_GROWING (a sustained growth trend, not just a depth) and
 * NO_ACTIVE_WORKERS. Re-implementing them here would mean two detectors racing
 * on the same queues with two sets of thresholds — the classic way to get
 * duplicate pages that disagree with each other. Registering as a CHANNEL on
 * the existing AlertService instead keeps detection where it already lives and
 * gives it a real destination, which was the documented extension point:
 * "`registerChannel` is the seam where Telegram … is added later WITHOUT
 * touching detection logic."
 *
 * ── Dedupe ownership ──
 * Deliberately NOT routed through AlertStateStore. Ops alerts already carry
 * their own suppression (QUEUE_ALERT_COOLDOWN_MIN, applied before `deliver` is
 * ever called), so passing them through a second dedupe layer would suppress
 * the re-fires that cooldown is specifically designed to emit. They are
 * delivered as they arrive; this module's state machine governs only its own
 * rules.
 *
 * Ops alerts therefore never produce a "✅ Resolved" message — AlertService's
 * `resolve()` only clears a cooldown, it has no resolution event to forward.
 * Noted in the follow-ups as the natural next consolidation step.
 */
@Injectable()
export class OpsAlertBridge implements OnModuleInit, OpsAlertChannel {
  readonly name = 'alerting-bridge';

  private readonly logger = new Logger(OpsAlertBridge.name);
  private readonly environmentLabel: string;

  constructor(
    private readonly ops: AlertService,
    private readonly notifier: AlertNotifierService,
    @Inject(ALERT_SOURCE) private readonly source: AlertSource,
    config: ConfigService,
  ) {
    this.environmentLabel = resolveAlertingConfig(config).environmentLabel;
  }

  onModuleInit(): void {
    this.ops.registerChannel(this);
    this.logger.log('Queue-monitor alerts now route to the alerting channels');
  }

  /**
   * Translate an ops alert into a notification and hand it to the notifier.
   *
   * Must not throw (the ops AlertChannel contract): AlertNotifierService.notify
   * already swallows its own failures, so this is satisfied by construction.
   */
  async deliver(alert: Alert): Promise<void> {
    const labels: AlertLabels = {
      queue: alert.queue,
      environment: this.environmentLabel.toLowerCase(),
    };

    const dedupeKey = alertDedupeKey(alert.type, labels);

    await this.notifier.notify({
      // Same dedupe-key shape the native rules produce, so ops alerts group and
      // filter identically downstream — including the fingerprint, so a queue
      // alert is quotable in chat exactly like a native one.
      dedupeKey,
      fingerprint: alertFingerprint(dedupeKey),
      state: ALERT_STATE.ACTIVE,
      rule: alert.type,
      severity: mapOpsSeverity(alert.severity),
      labels,
      values: { detail: alert.message, ...contextValues(alert.context) },
      title: opsAlertTitle(alert),
      summary: alert.message,
      // Ops alerts carry no links: their conditions (failed jobs, stalled
      // workers) are diagnosed in Bull Board rather than on a Grafana panel,
      // and inventing a dashboard URL for them would send the operator to the
      // wrong place. Wiring them up is a config-only change if that changes.
      links: {},
      source: this.source,
      firedAt: alert.firedAt.getTime(),
    });
  }
}

/**
 * Map the ops module's two-level severity onto the four-level scale.
 *
 * `critical` → CRITICAL and `warning` → ERROR rather than WARNING: every ops
 * alert already survived its own detection thresholds (N consecutive growing
 * samples, a failed-job floor), so by the time one is raised it is a confirmed
 * problem, not a soft signal.
 */
export function mapOpsSeverity(severity: OpsAlertSeverity): AlertSeverity {
  return severity === 'critical' ? AlertSeverity.CRITICAL : AlertSeverity.ERROR;
}

/** `failed_jobs` + `sms` → `Sms — Failed Jobs`. */
export function opsAlertTitle(alert: Pick<Alert, 'type' | 'queue'>): string {
  const type = alert.type
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return `${titleCase(alert.queue)} — ${type}`;
}

/**
 * Flatten the ops alert's structured context into alert values.
 *
 * Only primitives are carried over: the context is `Record<string, unknown>`,
 * and a nested object would stringify to `[object Object]` — noise in the one
 * place that has to stay readable. Keys are kept as-is; the renderer
 * humanizes them at display time.
 */
function contextValues(context: Record<string, unknown>): AlertValues {
  const entries = Object.entries(context)
    .filter(
      ([, value]) =>
        typeof value === 'number' ||
        typeof value === 'string' ||
        typeof value === 'boolean',
    )
    .map(([key, value]): [string, string | number] => [
      key,
      typeof value === 'boolean' ? String(value) : (value as string | number),
    ]);

  return Object.fromEntries(entries);
}

/** `image-processing` → `Image Processing`. */
function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
