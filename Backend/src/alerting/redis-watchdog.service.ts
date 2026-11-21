import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { boolEnv, positiveIntEnv } from '../ops/ops.config';
import { RedisService } from '../redis/redis.service';
import { resolveAlertingConfig } from './alerting.config';
import { ALERT_SOURCE } from './build-info';
import {
  ALERT_CHANNELS,
  ALERT_STATE,
  AlertSeverity,
  alertDedupeKey,
  alertFingerprint,
  type AlertChannel,
  type AlertLabels,
  type AlertNotification,
  type AlertSource,
} from './alerting.types';
import { truncate, withTimeout } from './rules/backend-health.rule';

/**
 * Tells the channels that Redis is down, WITHOUT Redis.
 *
 * Every other alert goes through Redis twice: its dedupe state (AlertStateStore) and its
 * delivery queue (BullMQ). So when Redis itself is the outage, the normal path cannot say
 * so — which is why this exists, and why the health rule no longer probes Redis.
 *
 * It PINGs on its own timer and, after REDIS_WATCHDOG_FAILURES checks in a row fail,
 * calls the channels DIRECTLY (each send is bounded, see channels/telegram-send.ts). Its
 * state is in memory: one message when Redis goes, a reminder every ALERT_RENOTIFY_MIN
 * while it stays down, and "✅ Resolved" to the same channels when it is back. A channel
 * that could not be reached is tried again on the next check.
 *
 *   REDIS_WATCHDOG_ENABLED       on unless set to anything but `true`; also off with
 *                                ALERTING_ENABLED=false.
 *   REDIS_WATCHDOG_INTERVAL_SEC  seconds between checks, default 30.
 *   REDIS_WATCHDOG_FAILURES      failed checks in a row before alerting, default 2, so one
 *                                lost PING (a Redis restart, a fork for a snapshot) is not
 *                                an incident. Default detection: about a minute.
 *
 * Limits, by construction: in-memory state means each backend instance reports on its
 * own (production runs one); and a backend that cannot start because Redis is down
 * (RedisService refuses to boot without it) never reaches this — an external uptime
 * check on /health is what covers a process that is not running.
 */
const DEFAULT_INTERVAL_SEC = 30;
const DEFAULT_FAILURES = 2;
const RULE = 'redis_down';
const MAX_ERROR_CHARS = 180;

interface Outage {
  /** First failed check of this outage. */
  since: number;
  lastError: string;
  /** Channel name → when it was last told, for reminders and for the recovery. */
  notifiedAt: Map<string, number>;
}

@Injectable()
export class RedisWatchdog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisWatchdog.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly failuresToAlert: number;
  private readonly timeoutMs: number;
  private readonly renotifyMs: number;
  private readonly labels: AlertLabels;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private failures = 0;
  private firstFailureAt = 0;
  private lastError = '';
  private outage: Outage | null = null;

  constructor(
    private readonly redis: RedisService,
    @Inject(ALERT_CHANNELS) private readonly channels: readonly AlertChannel[],
    @Inject(ALERT_SOURCE) private readonly source: AlertSource,
    config: ConfigService,
  ) {
    const alerting = resolveAlertingConfig(config);
    this.enabled =
      alerting.enabled &&
      boolEnv(config.get<string>('REDIS_WATCHDOG_ENABLED'), true);
    this.intervalMs =
      positiveIntEnv(
        config.get<string>('REDIS_WATCHDOG_INTERVAL_SEC'),
        DEFAULT_INTERVAL_SEC,
      ) * 1000;
    this.failuresToAlert = positiveIntEnv(
      config.get<string>('REDIS_WATCHDOG_FAILURES'),
      DEFAULT_FAILURES,
    );
    this.timeoutMs = alerting.healthTimeoutMs;
    this.renotifyMs = alerting.renotifyMin * 60 * 1000;
    this.labels = {
      component: 'redis',
      environment: alerting.environmentLabel.toLowerCase(),
    };
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    this.logger.log(
      `Redis watchdog: PING every ${this.intervalMs / 1000}s, ` +
        `alert after ${this.failuresToAlert} failed check(s)`,
    );
  }

  onModuleDestroy(): void {
    // Shutdown closes Redis; a PING failing because of that is not an outage.
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One check, never overlapping another. Never throws. Public for tests. */
  async tick(now = Date.now()): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const error = await this.ping();
      if (this.stopped) return;
      if (error === null) {
        await this.onHealthy(now);
      } else {
        await this.onFailure(error, now);
      }
    } catch (err) {
      this.logger.error(
        `Redis watchdog check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Null when Redis answered, else why not. */
  private async ping(): Promise<string | null> {
    try {
      await withTimeout(
        this.redis.getClient().ping(),
        this.timeoutMs,
        'Redis PING',
      );
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async onFailure(error: string, now: number): Promise<void> {
    if (this.failures === 0) this.firstFailureAt = now;
    this.failures += 1;
    this.lastError = error;
    this.logger.warn(
      `Redis PING failed (${this.failures}/${this.failuresToAlert}): ${error}`,
    );
    if (this.failures < this.failuresToAlert) return;

    this.outage ??= {
      since: this.firstFailureAt,
      lastError: error,
      notifiedAt: new Map(),
    };
    this.outage.lastError = error;

    for (const channel of this.channels) {
      if (!channel.configured) continue;
      const told = this.outage.notifiedAt.get(channel.name);
      const due =
        told === undefined ||
        (this.renotifyMs > 0 && now - told >= this.renotifyMs);
      if (!due) continue;
      const notification = this.activeNotification(now, told !== undefined);
      if (!channel.accepts(notification)) continue;
      if (await this.send(channel, notification)) {
        this.outage.notifiedAt.set(channel.name, now);
      }
    }
  }

  private async onHealthy(now: number): Promise<void> {
    this.failures = 0;
    const outage = this.outage;
    if (outage === null) return;
    this.outage = null;
    this.logger.log(
      `Redis is reachable again after ${Math.round((now - outage.since) / 1000)}s`,
    );
    // Only those told of the outage hear of its end — whatever their severity floor,
    // since an outage announced and never closed reads as still going on.
    const resolved = this.resolvedNotification(now, outage);
    for (const channel of this.channels) {
      if (outage.notifiedAt.has(channel.name)) {
        await this.send(channel, resolved);
      }
    }
  }

  private async send(
    channel: AlertChannel,
    notification: AlertNotification,
  ): Promise<boolean> {
    try {
      await channel.deliver(notification);
      this.logger.log(
        `[${notification.fingerprint}] Redis ${notification.state} sent via ${channel.name}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `[${notification.fingerprint}] Redis ${notification.state} via ${channel.name} failed ` +
          `(tried again next check): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private base(now: number): Omit<AlertNotification, 'state' | 'severity'> {
    const dedupeKey = alertDedupeKey(RULE, this.labels);
    return {
      dedupeKey,
      fingerprint: alertFingerprint(dedupeKey),
      rule: RULE,
      labels: this.labels,
      values: {},
      title: 'Redis Unreachable',
      summary: 'Redis connectivity',
      links: {},
      source: this.source,
      firedAt: now,
    };
  }

  private activeNotification(
    now: number,
    reminder: boolean,
  ): AlertNotification {
    return {
      ...this.base(now),
      state: ALERT_STATE.ACTIVE,
      // CRITICAL: queues, OTP codes, rate limits and sessions all stop with Redis.
      severity: AlertSeverity.CRITICAL,
      values: {
        status: 'unreachable',
        error: truncate(this.lastError, MAX_ERROR_CHARS),
        failed_checks: this.failures,
        effect: 'queues, SMS codes, rate limits and alert delivery are down',
      },
      ...(reminder
        ? {
            activeForMs: now - (this.outage?.since ?? now),
            renotification: true,
          }
        : {}),
    };
  }

  private resolvedNotification(now: number, outage: Outage): AlertNotification {
    return {
      ...this.base(now),
      state: ALERT_STATE.RESOLVED,
      severity: AlertSeverity.INFO,
      values: { status: 'reachable' },
      activeForMs: now - outage.since,
    };
  }
}
