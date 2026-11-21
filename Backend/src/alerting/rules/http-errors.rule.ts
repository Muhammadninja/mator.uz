import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ServerErrorLog,
  serverErrors,
  type ServerErrorSnapshot,
} from '../../common/server-errors';
import { positiveIntEnv } from '../../ops/ops.config';
import { resolveAlertingConfig } from '../alerting.config';
import {
  AlertSeverity,
  NO_ALERTS,
  type AlertRule,
  type RuleResult,
} from '../alerting.types';
import { SnapshotWindow } from '../snapshot-window';
import { truncate } from './backend-health.rule';

/**
 * Alerts when the API answered HTTP 5xx: an unexpected exception (500), an upstream that
 * failed (502/504), a dependency that refused (503).
 *
 * Counts what the global HttpExceptionFilter answered (src/common/server-errors.ts), over
 * the same rolling window as the other rate rules (ALERT_RATE_WINDOW_MIN, 5 min):
 *   • HTTP_5XX_ALERT_THRESHOLD    errors in the window that raise it (ERROR). Default 1:
 *     in this app a 500 is a bug, not background noise.
 *   • HTTP_5XX_CRITICAL_THRESHOLD errors in the window that make it CRITICAL. Default 50:
 *     the API is failing for real, and CRITICAL also ignores the startup grace period.
 *
 * One alert instance for the whole API. While errors keep coming it stays ACTIVE (one
 * message, then a reminder every ALERT_RENOTIFY_MIN), and it resolves once a whole window
 * passes below the threshold, so a stream of 500s is never a stream of messages. The
 * message says which routes and statuses, and the last error with its request id, which
 * is what `grep` in logs/error.log needs.
 *
 * Per process: a restart starts the count again, like every in-process metric here.
 */
const DEFAULT_THRESHOLD = 1;
const DEFAULT_CRITICAL_THRESHOLD = 50;
/** Routes and statuses named in the message; the rest are summed into the total. */
const TOP = 3;
const MAX_ERROR_CHARS = 200;

@Injectable()
export class HttpErrorsRule implements AlertRule {
  readonly name = 'http_5xx';

  /** The backend overview, where the HTTP status panels are. */
  readonly dashboardUrl = '/d/mator-backend-overview';

  private readonly threshold: number;
  private readonly criticalThreshold: number;
  private readonly windowMin: number;
  private readonly window: SnapshotWindow<ServerErrorSnapshot>;
  private readonly log: ServerErrorLog;

  constructor(
    config: ConfigService,
    // The process-wide log by default; a test passes its own.
    @Optional() log?: ServerErrorLog,
  ) {
    this.log = log ?? serverErrors;
    this.windowMin = resolveAlertingConfig(config).rateWindowMin;
    this.threshold = positiveIntEnv(
      config.get<string>('HTTP_5XX_ALERT_THRESHOLD'),
      DEFAULT_THRESHOLD,
    );
    this.criticalThreshold = Math.max(
      this.threshold,
      positiveIntEnv(
        config.get<string>('HTTP_5XX_CRITICAL_THRESHOLD'),
        DEFAULT_CRITICAL_THRESHOLD,
      ),
    );
    this.window = new SnapshotWindow(this.windowMin * 60 * 1000);
    // The baseline is "nothing yet", so errors from the first minutes after a boot (a bad
    // deploy) count from the very first evaluation.
    this.window.push(this.log.snapshot());
  }

  evaluate(now = Date.now()): Promise<RuleResult> {
    const current = this.log.snapshot(now);
    const baseline = this.window.push(current);
    if (baseline === undefined) return Promise.resolve(NO_ALERTS);

    const errors = current.total - baseline.total;
    if (errors < this.threshold) return Promise.resolve(NO_ALERTS);

    const values: Record<string, string | number> = {
      [`errors_${this.windowMin}min`]: errors,
      threshold: this.threshold,
      statuses: topDeltas(current.byStatus, baseline.byStatus),
      routes: topDeltas(current.byRoute, baseline.byRoute),
    };
    const last = this.log.latestSince(baseline.takenAt);
    if (last !== undefined) {
      values.last_error = truncate(last.message, MAX_ERROR_CHARS);
      values.last_route = last.route;
      if (last.requestId) values.last_request_id = last.requestId;
    }

    return Promise.resolve({
      firing: [
        {
          rule: this.name,
          severity:
            errors >= this.criticalThreshold
              ? AlertSeverity.CRITICAL
              : AlertSeverity.ERROR,
          labels: {},
          values,
          title: 'HTTP 5xx Errors',
          summary: 'HTTP 5xx errors',
          resolvedValues: {
            [`errors_${this.windowMin}min`]: `below ${this.threshold}`,
          },
        },
      ],
    });
  }
}

/** `POST /v1/orders ×4, GET /v1/cart ×1` — the largest increases, at most TOP. */
export function topDeltas<K>(
  current: ReadonlyMap<K, number>,
  baseline: ReadonlyMap<K, number>,
): string {
  const deltas = [...current]
    .map(([key, count]) => [key, count - (baseline.get(key) ?? 0)] as const)
    .filter(([, delta]) => delta > 0)
    .sort((a, b) => b[1] - a[1]);
  const shown = deltas
    .slice(0, TOP)
    .map(([key, delta]) => `${String(key)} ×${delta}`);
  const rest = deltas.length - TOP;
  return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ');
}
