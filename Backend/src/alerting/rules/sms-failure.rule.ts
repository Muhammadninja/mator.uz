import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { resolveAlertingConfig, type AlertingConfig } from '../alerting.config';
import {
  AlertSeverity,
  NO_ALERTS,
  type AlertPayload,
  type AlertRule,
  type RuleResult,
} from '../alerting.types';
import {
  counterIncrease,
  snapshotCounterBy,
  type CounterSnapshot,
} from '../metric-window';
import { SnapshotWindow } from '../snapshot-window';

/**
 * Alerts when SMS failures within the rolling window exceed
 * SMS_FAILURE_THRESHOLD.
 *
 * ── Per provider, not aggregate ──
 * One alert instance per provider (`sms_failures:eskiz`), because SMS is routed
 * across providers (see src/sms/resolver): an aggregate count would say "SMS is
 * failing" when the actionable fact is "Eskiz is failing and traffic should move
 * to the fallback". The provider name is exactly what the operator needs in the
 * first line of the message.
 *
 * ── Windowed, not cumulative ──
 * Reuses the `sms_failed_total` counter the SMS worker ALREADY increments and
 * differences it against the oldest snapshot inside the window — the in-process
 * equivalent of `increase(sms_failed_total[5m])`. A cumulative read would fire
 * once and never recover. See metric-window.ts and snapshot-window.ts.
 */
@Injectable()
export class SmsFailureRule implements AlertRule {
  readonly name = 'sms_failures';

  private readonly logger = new Logger(SmsFailureRule.name);
  private readonly config: AlertingConfig;
  /** One window of snapshots per provider label. */
  private readonly windows = new Map<string, SnapshotWindow<CounterSnapshot>>();
  private readonly windowMs: number;

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.config = resolveAlertingConfig(config);
    this.windowMs = this.config.rateWindowMin * 60 * 1000;
  }

  async evaluate(): Promise<RuleResult> {
    const current = await snapshotCounterBy(
      this.metrics.smsFailedMetric,
      PROVIDER_LABEL,
    );

    const firing: AlertPayload[] = [];

    for (const [provider, snapshot] of current) {
      const window = this.windowFor(provider);
      const baseline = window.push(snapshot);

      // No baseline yet — this provider was first seen this tick. Establish it
      // and evaluate from the next run rather than treating its whole
      // cumulative history as if it happened inside the window.
      if (baseline === undefined) continue;

      const failures = counterIncrease(baseline, snapshot);
      if (failures <= this.config.smsFailureThreshold) continue;

      this.logger.debug(
        `SMS failures for ${provider}: ${failures} in ${this.config.rateWindowMin}min ` +
          `(threshold ${this.config.smsFailureThreshold})`,
      );

      firing.push({
        rule: this.name,
        // CRITICAL: failing SMS means OTP codes are not arriving, which locks
        // users out of the app entirely. This is user-facing, not degraded.
        severity: AlertSeverity.CRITICAL,
        labels: { provider },
        values: {
          [`failures_${this.config.rateWindowMin}min`]: failures,
          threshold: this.config.smsFailureThreshold,
        },
        title: 'SMS Failures',
        summary: `SMS failures for ${provider}`,
      });
    }

    return firing.length > 0 ? { firing } : NO_ALERTS;
  }

  /** The snapshot window for one provider, created on first sight. */
  private windowFor(provider: string): SnapshotWindow<CounterSnapshot> {
    let window = this.windows.get(provider);
    if (window === undefined) {
      window = new SnapshotWindow<CounterSnapshot>(this.windowMs);
      this.windows.set(provider, window);
    }
    return window;
  }
}

/** The label `smsFailedTotal` carries the provider name under. */
const PROVIDER_LABEL = 'provider';
