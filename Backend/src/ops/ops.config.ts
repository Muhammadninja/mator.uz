import type { ConfigService } from '@nestjs/config';
import { QUEUE_NAMES, type QueueName } from '../queue/queue.constants';

/**
 * Operations tooling configuration (Bull Board + queue health monitoring),
 * resolved from environment variables in ONE place so the defaults are visible
 * and the parsing rules are shared.
 *
 * Every value has a safe default: with no new env vars set, the monitor runs
 * with sensible thresholds and Bull Board stays DISABLED. Turning the dashboard
 * on is always an explicit, deliberate act (BULL_BOARD_ENABLED=true).
 */

/** Parse a positive integer env var, falling back when unset/invalid. */
export function positiveIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** `true` only for an explicit "true" — anything else (including unset) is false. */
export function boolEnv(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

// ── Bull Board ──────────────────────────────────────────────────────────────

export interface BullBoardConfig {
  /** Whether to mount the dashboard at all. Off unless explicitly enabled. */
  enabled: boolean;
  /** Mount path, e.g. `/admin/queues`. */
  route: string;
  /** Basic Auth user. Empty when unset. */
  user: string;
  /** Basic Auth password. Empty when unset. */
  password: string;
  /** Read-only mode — hides destructive actions (retry/remove) in the UI. */
  readOnly: boolean;
}

const DEFAULT_BULL_BOARD_ROUTE = '/admin/queues';

export function resolveBullBoardConfig(
  config: Pick<ConfigService, 'get'>,
): BullBoardConfig {
  const route = config.get<string>('BULL_BOARD_ROUTE')?.trim();

  return {
    enabled: boolEnv(config.get<string>('BULL_BOARD_ENABLED')),
    route: route && route.length > 0 ? route : DEFAULT_BULL_BOARD_ROUTE,
    user: config.get<string>('BULL_BOARD_USER')?.trim() ?? '',
    password: config.get<string>('BULL_BOARD_PASSWORD') ?? '',
    // Default to read-only: the safe posture for a production dashboard is to
    // observe. Mutating actions require an explicit opt-out.
    readOnly: !boolEnv(config.get<string>('BULL_BOARD_ALLOW_MUTATIONS')),
  };
}

// ── Queue health monitoring ─────────────────────────────────────────────────

export interface QueueMonitorConfig {
  /** Whether the periodic sampling runs. */
  enabled: boolean;
  /** Seconds between samples. */
  intervalSec: number;
  /** Failed-count at or above which a FAILED_JOBS alert fires, per queue. */
  failedThreshold: number;
  /** Waiting-count below which growth is never considered a backlog. */
  waitingThreshold: number;
  /**
   * Consecutive samples of strictly-growing `waiting` needed before a
   * WAITING_GROWING alert fires. Guards against alerting on a normal burst.
   */
  waitingGrowthSamples: number;
  /** Minutes an alert of the same key stays suppressed after firing. */
  cooldownMin: number;
}

const DEFAULT_MONITOR_INTERVAL_SEC = 60;
const DEFAULT_FAILED_THRESHOLD = 25;
const DEFAULT_WAITING_THRESHOLD = 100;
const DEFAULT_WAITING_GROWTH_SAMPLES = 3;
const DEFAULT_ALERT_COOLDOWN_MIN = 15;

export function resolveQueueMonitorConfig(
  config: Pick<ConfigService, 'get'>,
): QueueMonitorConfig {
  return {
    enabled: boolEnv(config.get<string>('QUEUE_MONITOR_ENABLED'), true),
    intervalSec: positiveIntEnv(
      config.get<string>('QUEUE_MONITOR_INTERVAL_SEC'),
      DEFAULT_MONITOR_INTERVAL_SEC,
    ),
    failedThreshold: positiveIntEnv(
      config.get<string>('QUEUE_ALERT_FAILED_THRESHOLD'),
      DEFAULT_FAILED_THRESHOLD,
    ),
    waitingThreshold: positiveIntEnv(
      config.get<string>('QUEUE_ALERT_WAITING_THRESHOLD'),
      DEFAULT_WAITING_THRESHOLD,
    ),
    waitingGrowthSamples: positiveIntEnv(
      config.get<string>('QUEUE_ALERT_WAITING_GROWTH_SAMPLES'),
      DEFAULT_WAITING_GROWTH_SAMPLES,
    ),
    cooldownMin: positiveIntEnv(
      config.get<string>('QUEUE_ALERT_COOLDOWN_MIN'),
      DEFAULT_ALERT_COOLDOWN_MIN,
    ),
  };
}

/**
 * The queues the Bull Board dashboard exposes — every registered queue,
 * derived from QUEUE_NAMES so a newly registered queue is covered without
 * touching this file. The dashboard is a read-only inspector, so including the
 * alerts queue here is desirable: a failed Telegram delivery is exactly the
 * kind of job an operator needs to see and retry.
 */
export const MONITORED_QUEUES: readonly QueueName[] =
  Object.values(QUEUE_NAMES);

/**
 * The queues the health MONITOR samples and the metrics collector publishes.
 *
 * Every registered queue except `alerts`. The alerts queue is deliberately
 * excluded from monitoring-that-alerts: a backlog or failure there means alert
 * delivery is broken, so an alert about it could not be delivered — a watchdog
 * must not depend on the thing it watches. Its depth is still visible in Bull
 * Board (above) and via the `bullmq_jobs` gauge that Prometheus scrapes, which
 * is where that condition belongs.
 */
export const SAMPLED_QUEUES: readonly QueueName[] = MONITORED_QUEUES.filter(
  (queue) => queue !== QUEUE_NAMES.ALERTS,
);
