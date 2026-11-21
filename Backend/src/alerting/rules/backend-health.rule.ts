import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveAlertingConfig } from '../alerting.config';
import {
  AlertSeverity,
  NO_ALERTS,
  type AlertPayload,
  type AlertRule,
  type RuleResult,
} from '../alerting.types';

/**
 * Alerts when PostgreSQL cannot be reached from THIS process.
 *
 * ── Why an application-level probe ──
 * The brief is explicit: do not infer this from Prometheus scrape failures. A
 * failed scrape means "the metrics endpoint did not answer", which conflates a
 * dead database with a dead process, a network partition to the scraper, or a
 * Prometheus restart — and it cannot distinguish Postgres from Redis at all.
 * A `SELECT 1` and a `PING` issued from the same process, over the same pools
 * the app actually uses, answer the real question: can this backend serve
 * traffic right now?
 *
 * Each probe is bounded by ALERT_HEALTH_TIMEOUT_MS. Without a timeout a hung
 * TCP connection would hang the evaluation itself — the monitoring equivalent
 * of the failure it is meant to report.
 *
 * Redis is NOT probed here. Alert state and delivery both live in Redis, so an
 * alert about Redis raised through this path could never be sent: RedisWatchdog
 * (src/alerting/redis-watchdog.service.ts) watches it and reaches the channels
 * without Redis. Probing it here as well would only add a duplicate message on a
 * partial outage.
 */

/** The probes this rule runs. Adding a dependency means adding one entry. */
interface HealthProbe {
  /** Dimension in the dedupe key, e.g. `database`. */
  readonly id: string;
  /** Human name used in the message title. */
  readonly label: string;
  /** Resolves when reachable; rejects/throws when not. */
  check(): Promise<unknown>;
}

@Injectable()
export class BackendHealthRule implements AlertRule {
  readonly name = 'backend_health';

  /**
   * The backend overview — process, HTTP and dependency health in one place.
   * Not per-component: when Postgres is unreachable the useful view is the
   * whole backend's state, not one panel.
   */
  readonly dashboardUrl = '/d/mator-backend-overview';

  private readonly logger = new Logger(BackendHealthRule.name);
  private readonly timeoutMs: number;
  private readonly probes: readonly HealthProbe[];

  constructor(prisma: PrismaService, config: ConfigService) {
    this.timeoutMs = resolveAlertingConfig(config).healthTimeoutMs;

    this.probes = [
      {
        id: 'database',
        label: 'Database',
        // The same trivial query HealthController uses, so the alert and the
        // load balancer's readiness probe agree on what "up" means.
        check: () => prisma.$queryRaw`SELECT 1`,
      },
    ];
  }

  async evaluate(): Promise<RuleResult> {
    const results = await Promise.all(
      this.probes.map((probe) => this.runProbe(probe)),
    );

    const firing = results.filter((r): r is AlertPayload => r !== null);
    return firing.length > 0 ? { firing } : NO_ALERTS;
  }

  /** Run one probe under a timeout. Returns a payload when it is DOWN. */
  private async runProbe(probe: HealthProbe): Promise<AlertPayload | null> {
    const startedAt = Date.now();
    try {
      await withTimeout(probe.check(), this.timeoutMs, probe.label);
      return null;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Health probe "${probe.id}" failed: ${reason}`);

      return {
        rule: this.name,
        // Always CRITICAL — and therefore never suppressed by the startup grace
        // period or maintenance mode (see AlertSilenceService). If Postgres is
        // unreachable 5s after a deploy, that IS the news.
        severity: AlertSeverity.CRITICAL,
        labels: { component: probe.id },
        values: {
          status: 'unreachable',
          error: truncate(reason, MAX_REASON_CHARS),
          checked_for: `${Date.now() - startedAt} ms`,
        },
        title: `${probe.label} Unreachable`,
        summary: `${probe.label} connectivity`,
        resolvedValues: { status: 'reachable' },
      };
    }
  }
}

/**
 * Reject after `ms` if `promise` has not settled.
 *
 * The timer is always cleared, so a fast probe never leaves a pending timeout
 * holding the event loop between evaluations.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} check timed out after ${ms}ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Provider error messages can be long; keep the Telegram message readable. */
const MAX_REASON_CHARS = 180;

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
