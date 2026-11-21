import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { positiveIntEnv } from '../../ops/ops.config';
import { resolveAlertingConfig } from '../alerting.config';
import {
  AlertSeverity,
  NO_ALERTS,
  type AlertLabels,
  type AlertPayload,
  type AlertRule,
  type AlertValues,
  type RuleResult,
} from '../alerting.types';
import { withTimeout } from './backend-health.rule';

/**
 * Watches the Redis this backend depends on for the two ways it fails while still
 * answering PING (a Redis that does not answer is RedisWatchdog's, which does not need
 * Redis to tell anyone):
 *
 *   • memory — `used_memory` against `maxmemory`, or against the machine's RAM when no
 *     maxmemory is set. At the limit Redis refuses writes: the queues, OTP codes, rate
 *     limits and alert state all stop. ERROR at REDIS_MEMORY_ALERT_PERCENT (85), CRITICAL
 *     at REDIS_MEMORY_CRITICAL_PERCENT (95).
 *   • eviction_policy — with a maxmemory set, any policy but `noeviction` lets Redis
 *     delete keys under pressure, and BullMQ loses jobs silently. WARNING, until the
 *     setting is fixed.
 *
 * Read-only: one `INFO memory` per evaluation, under the health timeout.
 */
const DEFAULT_WARN_PERCENT = 85;
const DEFAULT_CRITICAL_PERCENT = 95;
const REQUIRED_POLICY = 'noeviction';

/** The `INFO memory` fields this rule reads. */
export interface RedisMemoryInfo {
  usedBytes: number;
  maxBytes: number;
  systemBytes: number;
  policy: string;
}

@Injectable()
export class RedisMemoryRule implements AlertRule {
  readonly name = 'redis_memory';

  readonly dashboardUrl = '/d/mator-backend-overview';

  private readonly warnPercent: number;
  private readonly criticalPercent: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.timeoutMs = resolveAlertingConfig(config).healthTimeoutMs;
    this.warnPercent = positiveIntEnv(
      config.get<string>('REDIS_MEMORY_ALERT_PERCENT'),
      DEFAULT_WARN_PERCENT,
    );
    this.criticalPercent = Math.max(
      this.warnPercent,
      positiveIntEnv(
        config.get<string>('REDIS_MEMORY_CRITICAL_PERCENT'),
        DEFAULT_CRITICAL_PERCENT,
      ),
    );
  }

  async evaluate(): Promise<RuleResult> {
    const info = await this.readInfo();
    const firing: AlertPayload[] = [];

    const usage = this.usage(info);
    if (usage !== null && usage.percent >= this.warnPercent) {
      firing.push({
        rule: this.name,
        severity:
          usage.percent >= this.criticalPercent
            ? AlertSeverity.CRITICAL
            : AlertSeverity.ERROR,
        labels: { check: 'memory' },
        values: usage.values,
        title: 'Redis Memory',
        summary: 'Redis memory usage',
      });
    }

    if (info.maxBytes > 0 && info.policy && info.policy !== REQUIRED_POLICY) {
      firing.push({
        rule: this.name,
        severity: AlertSeverity.WARNING,
        labels: { check: 'eviction_policy' },
        values: { policy: info.policy, required: REQUIRED_POLICY },
        title: 'Redis Eviction Policy',
        summary: 'Redis eviction policy',
        resolvedValues: { policy: REQUIRED_POLICY },
      });
    }

    return firing.length > 0 ? { firing } : NO_ALERTS;
  }

  /** The recovered reading, so "Resolved" does not repeat the number that tripped it. */
  async resolvedValuesFor(
    labels: AlertLabels,
  ): Promise<AlertValues | undefined> {
    if (labels.check !== 'memory') return undefined;
    try {
      return this.usage(await this.readInfo())?.values;
    } catch {
      return undefined;
    }
  }

  private async readInfo(): Promise<RedisMemoryInfo> {
    const raw = await withTimeout(
      this.redis.getClient().info('memory'),
      this.timeoutMs,
      'Redis INFO',
    );
    return parseRedisMemoryInfo(raw);
  }

  private usage(
    info: RedisMemoryInfo,
  ): { percent: number; values: AlertValues } | null {
    const limit = info.maxBytes > 0 ? info.maxBytes : info.systemBytes;
    if (limit <= 0) return null;
    const percent = (info.usedBytes / limit) * 100;
    return {
      percent,
      values: {
        usage: `${Math.round(percent)}%`,
        used: formatBytes(info.usedBytes),
        limit: `${formatBytes(limit)} (${info.maxBytes > 0 ? 'maxmemory' : 'machine RAM'})`,
        threshold: `${this.warnPercent}%`,
      },
    };
  }
}

/** Parse the `key:value` lines of `INFO memory`. Missing numbers read as 0. */
export function parseRedisMemoryInfo(raw: string): RedisMemoryInfo {
  const fields = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  const num = (key: string) => {
    const value = Number(fields.get(key));
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return {
    usedBytes: num('used_memory'),
    maxBytes: num('maxmemory'),
    systemBytes: num('total_system_memory'),
    policy: fields.get('maxmemory_policy') ?? '',
  };
}

/** `1288490188` → `1.2 GB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
