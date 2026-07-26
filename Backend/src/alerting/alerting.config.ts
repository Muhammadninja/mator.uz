import type { ConfigService } from '@nestjs/config';
import { QUEUE_NAMES, type QueueName } from '../queue/queue.constants';

/**
 * Alerting configuration, resolved from environment variables in ONE place.
 *
 * Every threshold in this module comes from here — no rule ever hardcodes a
 * number. Each value has a safe default so the system runs correctly with no
 * new env vars set, but every default is a documented, deliberate choice rather
 * than a magic constant buried in a rule.
 *
 * Parsing helpers are reused from ops.config.ts (`positiveIntEnv` / `boolEnv`)
 * so "what counts as a valid value" is defined once for all operations tooling.
 */

import { boolEnv, positiveIntEnv } from '../ops/ops.config';
import { AlertSeverity, parseSeverity } from './alerting.types';

/** Parse a positive float env var (used for second-valued latency thresholds). */
export function positiveFloatEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// ── Defaults ────────────────────────────────────────────────────────────────
// Named constants, not inline literals, so every default is greppable and
// carries its rationale in one place.

/** Evaluation cadence. One minute — the brief's requirement. */
const DEFAULT_EVAL_INTERVAL_SEC = 60;

/**
 * Waiting-job counts above which a queue is considered backlogged.
 *
 * Per-queue because the queues have genuinely different healthy depths: image
 * jobs are slow (tens of seconds each) so a depth of 100 is a real backlog,
 * while SMS drains in well under a second and a transient OTP burst of 100 is
 * normal. One shared threshold would either page on healthy SMS bursts or go
 * blind to a stalled image pipeline.
 */
const DEFAULT_IMAGE_QUEUE_THRESHOLD = 100;
const DEFAULT_SMS_QUEUE_THRESHOLD = 200;
const DEFAULT_NOTIFICATIONS_QUEUE_THRESHOLD = 200;
const DEFAULT_MAINTENANCE_QUEUE_THRESHOLD = 50;

/**
 * P95 image-processing seconds above which the pipeline is considered degraded.
 * 45s sits above the healthy FLUX + two-Cloudinary-round-trip envelope (see
 * IMAGE_DURATION_BUCKETS) but well under the point where sellers are waiting
 * visibly too long.
 */
const DEFAULT_IMAGE_P95_THRESHOLD_SEC = 45;

/** SMS failures within the rolling window before alerting. */
const DEFAULT_SMS_FAILURE_THRESHOLD = 10;

/**
 * The rolling window for rate-based rules (SMS failures, image P95). Five
 * minutes is long enough to smooth a single flaky provider response and short
 * enough that a real outage is caught inside the first few evaluations.
 */
const DEFAULT_RATE_WINDOW_MIN = 5;

/**
 * Minimum observations inside the window before a P95 is trusted. A quantile
 * over two samples is noise, and alerting on it would page for a single slow
 * image. Below this the rule reports nothing.
 */
const DEFAULT_P95_MIN_SAMPLES = 5;

/** How long a health-check (DB/Redis ping) may take before counting as down. */
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/**
 * How long an ACTIVE alert's state row survives without being re-confirmed.
 *
 * This is a safety net, not the dedupe mechanism: state is refreshed on every
 * evaluation while the condition holds, so the TTL only matters if the process
 * dies while an alert is ACTIVE. Generous (24h) so a still-broken condition is
 * not re-notified after a deploy, but bounded so a stale key cannot suppress an
 * alert forever.
 */
const DEFAULT_STATE_TTL_SEC = 24 * 60 * 60;

/**
 * Re-notify an alert that has stayed ACTIVE this long, so a long-running
 * incident resurfaces instead of going quiet after the first message.
 *
 * ON by default at 30 minutes. An alert that fires once and then goes silent is
 * indistinguishable from one that resolved — a queue down for six hours would
 * scroll out of the channel and be forgotten, which is the exact failure mode
 * alerting exists to prevent. Each re-notification carries how long the alert
 * has been active ("still active — 3h 25m"), so the message reads as an
 * escalating incident rather than a duplicate.
 *
 * Set to 0 to disable (notify once until it resolves).
 */
const DEFAULT_RENOTIFY_MIN = 30;

/** Delivery retry policy for the notification job. */
const DEFAULT_DELIVERY_ATTEMPTS = 5;
const DEFAULT_DELIVERY_BACKOFF_MS = 5_000;

/** Environment label shown in the message header, e.g. "Mator Production". */
const DEFAULT_ENVIRONMENT_LABEL = 'Production';

/**
 * How long after process start alerts are suppressed.
 *
 * A restart temporarily breaks almost every rule's premise: queues have not
 * drained yet, connection pools are still warming, and the rate-window rules
 * have no baseline to diff against. Alerting through that window produces
 * guaranteed false positives on every single deploy, which is how a channel
 * gets muted and then ignored.
 *
 * Two minutes covers a rolling restart without meaningfully delaying detection
 * of a genuine post-deploy failure. Health alerts are deliberately EXEMPT (see
 * ALERT_STARTUP_GRACE_MIN_SEVERITY): if Postgres is unreachable 5s after boot,
 * that is real and the deploy should be rolled back.
 */
const DEFAULT_STARTUP_GRACE_SEC = 120;

/**
 * Severity at or above which an alert IGNORES the startup grace period and the
 * maintenance silence. CRITICAL by default — an outage is an outage whether or
 * not we are mid-deploy, and silencing it is how a bad release goes unnoticed.
 */
const DEFAULT_GRACE_MIN_SEVERITY = AlertSeverity.CRITICAL;

/** Longest a `/alerts silence` may last, so a silence can never be permanent. */
const DEFAULT_MAX_SILENCE_MIN = 24 * 60;

/** Default duration when a silence is requested without one. */
const DEFAULT_SILENCE_MIN = 30;

/** Minimum severity a channel delivers, when it sets no override. */
const DEFAULT_MIN_SEVERITY = AlertSeverity.WARNING;

/** Timeout for an outbound webhook POST (Slack/Discord/generic). */
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

// ── Shapes ──────────────────────────────────────────────────────────────────

/**
 * The queues the backlog rule watches.
 *
 * Every registered queue EXCEPT `alerts`. Watching the alert queue itself would
 * be self-referential: a backlog there means alerts are not being delivered, so
 * the alert about it could not be delivered either. Alert delivery failures are
 * surfaced by AlertProcessor's terminal `error` log and by the
 * `bullmq_jobs{queue="alerts"}` gauge, which Prometheus already scrapes — the
 * correct place for a watchdog that must not depend on the thing it watches.
 */
export const BACKLOG_MONITORED_QUEUES = [
  QUEUE_NAMES.IMAGE_PROCESSING,
  QUEUE_NAMES.SMS,
  QUEUE_NAMES.NOTIFICATIONS,
  QUEUE_NAMES.MAINTENANCE,
] as const satisfies readonly QueueName[];

export type BacklogQueueName = (typeof BACKLOG_MONITORED_QUEUES)[number];

/** Per-queue waiting-job thresholds, keyed by monitored queue name. */
export type QueueThresholds = Readonly<Record<BacklogQueueName, number>>;

export interface AlertingConfig {
  /** Whether evaluation runs at all. */
  enabled: boolean;
  /** Seconds between evaluations. */
  intervalSec: number;
  /** Waiting-job threshold per queue. */
  queueThresholds: QueueThresholds;
  /** P95 image-processing seconds above which the latency rule fires. */
  imageP95ThresholdSec: number;
  /** SMS failures within the window above which the SMS rule fires. */
  smsFailureThreshold: number;
  /** Rolling window (minutes) for rate-based rules. */
  rateWindowMin: number;
  /** Minimum in-window observations before a P95 is considered meaningful. */
  p95MinSamples: number;
  /** Timeout (ms) applied to each application-level health probe. */
  healthTimeoutMs: number;
  /** TTL (seconds) of an alert's Redis state row. */
  stateTtlSec: number;
  /** Minutes before a still-ACTIVE alert is re-notified. 0 = never. */
  renotifyMin: number;
  /** Telegram chat id alerts are delivered to. Empty disables delivery. */
  telegramChatId: string;
  /**
   * Bot token used for alert delivery. Falls back to TELEGRAM_BOT_TOKEN so the
   * existing seller bot is reused by default (the brief's requirement), while
   * still allowing a dedicated ops bot without touching code.
   */
  telegramBotToken: string;
  /** BullMQ attempts for one alert notification job. */
  deliveryAttempts: number;
  /** Exponential backoff base (ms) for notification retries. */
  deliveryBackoffMs: number;
  /** Environment name in the message header. Also an alert label. */
  environmentLabel: string;
  /** Seconds after boot during which alerts are suppressed. 0 = no grace. */
  startupGraceSec: number;
  /**
   * Alerts at or above this severity bypass BOTH the startup grace period and
   * the maintenance silence.
   */
  graceMinSeverity: AlertSeverity;
  /** Whether maintenance mode is forced on by env (MAINTENANCE=true). */
  maintenanceMode: boolean;
  /** Longest a runtime silence may be requested for. */
  maxSilenceMin: number;
  /** Duration used when a silence is requested without one. */
  defaultSilenceMin: number;

  // ── Channels ──────────────────────────────────────────────────────────
  /** Minimum severity delivered, per channel. Unset entries use the default. */
  minSeverity: AlertSeverity;
  /** Slack incoming-webhook URL. Empty disables the channel. */
  slackWebhookUrl: string;
  /** Slack-specific minimum severity, falling back to `minSeverity`. */
  slackMinSeverity: AlertSeverity;
  /** Discord webhook URL. Empty disables the channel. */
  discordWebhookUrl: string;
  /** Discord-specific minimum severity. */
  discordMinSeverity: AlertSeverity;
  /** Generic JSON webhook URL (PagerDuty proxy, custom sink). */
  webhookUrl: string;
  /** Generic webhook minimum severity. */
  webhookMinSeverity: AlertSeverity;
  /** Optional `Authorization` header value for the generic webhook. */
  webhookAuthHeader: string;
  /** Telegram-specific minimum severity. */
  telegramMinSeverity: AlertSeverity;
  /** Timeout (ms) for an outbound webhook HTTP call. */
  webhookTimeoutMs: number;
}

/**
 * Env var name for a queue's threshold, e.g. `image-processing` →
 * `IMAGE_PROCESSING_QUEUE_ALERT_THRESHOLD`. Derived from the queue name so a
 * newly registered queue gets a threshold var without editing a mapping table.
 */
export function queueThresholdEnvVar(queue: string): string {
  return `${queue.replace(/-/g, '_').toUpperCase()}_QUEUE_ALERT_THRESHOLD`;
}

/**
 * The documented aliases the brief names explicitly. Checked BEFORE the derived
 * name so `IMAGE_QUEUE_ALERT_THRESHOLD` (short, what ops will actually type)
 * works alongside the systematic `IMAGE_PROCESSING_QUEUE_ALERT_THRESHOLD`.
 */
const QUEUE_THRESHOLD_ALIASES: Readonly<Record<string, string>> = {
  [QUEUE_NAMES.IMAGE_PROCESSING]: 'IMAGE_QUEUE_ALERT_THRESHOLD',
  [QUEUE_NAMES.SMS]: 'SMS_QUEUE_ALERT_THRESHOLD',
  [QUEUE_NAMES.NOTIFICATIONS]: 'NOTIFICATIONS_QUEUE_ALERT_THRESHOLD',
  [QUEUE_NAMES.MAINTENANCE]: 'MAINTENANCE_QUEUE_ALERT_THRESHOLD',
};

/** Built-in default per queue. */
const QUEUE_THRESHOLD_DEFAULTS: QueueThresholds = {
  [QUEUE_NAMES.IMAGE_PROCESSING]: DEFAULT_IMAGE_QUEUE_THRESHOLD,
  [QUEUE_NAMES.SMS]: DEFAULT_SMS_QUEUE_THRESHOLD,
  [QUEUE_NAMES.NOTIFICATIONS]: DEFAULT_NOTIFICATIONS_QUEUE_THRESHOLD,
  [QUEUE_NAMES.MAINTENANCE]: DEFAULT_MAINTENANCE_QUEUE_THRESHOLD,
};

/**
 * Resolve every queue's threshold. Precedence, first match wins:
 *   1. the documented alias (IMAGE_QUEUE_ALERT_THRESHOLD)
 *   2. the derived name  (IMAGE_PROCESSING_QUEUE_ALERT_THRESHOLD)
 *   3. ORDER_QUEUE_THRESHOLD-style generic fallback (QUEUE_ALERT_THRESHOLD)
 *   4. the per-queue built-in default
 */
export function resolveQueueThresholds(
  config: Pick<ConfigService, 'get'>,
): QueueThresholds {
  const generic = config.get<string>('QUEUE_ALERT_THRESHOLD');

  const entries = BACKLOG_MONITORED_QUEUES.map((queue) => {
    const alias = QUEUE_THRESHOLD_ALIASES[queue];
    const fallback = positiveIntEnv(generic, QUEUE_THRESHOLD_DEFAULTS[queue]);
    const raw =
      (alias ? config.get<string>(alias) : undefined) ??
      config.get<string>(queueThresholdEnvVar(queue));
    return [queue, positiveIntEnv(raw, fallback)] as const;
  });

  return Object.fromEntries(entries) as QueueThresholds;
}

export function resolveAlertingConfig(
  config: Pick<ConfigService, 'get'>,
): AlertingConfig {
  // Resolved first: it is the fallback for every per-channel severity below, so
  // setting ALERT_MIN_SEVERITY once raises the floor for all channels at once.
  const minSeverity = parseSeverity(
    config.get<string>('ALERT_MIN_SEVERITY'),
    DEFAULT_MIN_SEVERITY,
  );

  return {
    enabled: boolEnv(config.get<string>('ALERTING_ENABLED'), true),
    intervalSec: positiveIntEnv(
      config.get<string>('ALERTING_INTERVAL_SEC'),
      DEFAULT_EVAL_INTERVAL_SEC,
    ),
    queueThresholds: resolveQueueThresholds(config),
    imageP95ThresholdSec: positiveFloatEnv(
      config.get<string>('IMAGE_PROCESSING_P95_THRESHOLD'),
      DEFAULT_IMAGE_P95_THRESHOLD_SEC,
    ),
    smsFailureThreshold: positiveIntEnv(
      config.get<string>('SMS_FAILURE_THRESHOLD'),
      DEFAULT_SMS_FAILURE_THRESHOLD,
    ),
    rateWindowMin: positiveIntEnv(
      config.get<string>('ALERT_RATE_WINDOW_MIN'),
      DEFAULT_RATE_WINDOW_MIN,
    ),
    p95MinSamples: positiveIntEnv(
      config.get<string>('ALERT_P95_MIN_SAMPLES'),
      DEFAULT_P95_MIN_SAMPLES,
    ),
    healthTimeoutMs: positiveIntEnv(
      config.get<string>('ALERT_HEALTH_TIMEOUT_MS'),
      DEFAULT_HEALTH_TIMEOUT_MS,
    ),
    stateTtlSec: positiveIntEnv(
      config.get<string>('ALERT_STATE_TTL_SEC'),
      DEFAULT_STATE_TTL_SEC,
    ),
    // Not positiveIntEnv: 0 is a MEANINGFUL value here ("never re-notify") and
    // must survive parsing rather than falling back to the default.
    renotifyMin: nonNegativeIntEnv(
      config.get<string>('ALERT_RENOTIFY_MIN'),
      DEFAULT_RENOTIFY_MIN,
    ),
    telegramChatId: config.get<string>('ALERT_TELEGRAM_CHAT_ID')?.trim() ?? '',
    telegramBotToken:
      config.get<string>('ALERT_TELEGRAM_BOT_TOKEN')?.trim() ||
      config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() ||
      '',
    deliveryAttempts: positiveIntEnv(
      config.get<string>('ALERT_DELIVERY_ATTEMPTS'),
      DEFAULT_DELIVERY_ATTEMPTS,
    ),
    deliveryBackoffMs: positiveIntEnv(
      config.get<string>('ALERT_DELIVERY_BACKOFF_MS'),
      DEFAULT_DELIVERY_BACKOFF_MS,
    ),
    environmentLabel:
      config.get<string>('ALERT_ENVIRONMENT_LABEL')?.trim() ||
      DEFAULT_ENVIRONMENT_LABEL,
    startupGraceSec: nonNegativeIntEnv(
      config.get<string>('ALERT_STARTUP_GRACE_SEC'),
      DEFAULT_STARTUP_GRACE_SEC,
    ),
    graceMinSeverity: parseSeverity(
      config.get<string>('ALERT_STARTUP_GRACE_MIN_SEVERITY'),
      DEFAULT_GRACE_MIN_SEVERITY,
    ),
    // MAINTENANCE is the documented name; ALERT_MAINTENANCE_MODE is accepted so
    // the flag can be scoped to alerting alone if MAINTENANCE ever gains other
    // meaning in this app.
    maintenanceMode:
      boolEnv(config.get<string>('MAINTENANCE')) ||
      boolEnv(config.get<string>('ALERT_MAINTENANCE_MODE')),
    maxSilenceMin: positiveIntEnv(
      config.get<string>('ALERT_MAX_SILENCE_MIN'),
      DEFAULT_MAX_SILENCE_MIN,
    ),
    defaultSilenceMin: positiveIntEnv(
      config.get<string>('ALERT_DEFAULT_SILENCE_MIN'),
      DEFAULT_SILENCE_MIN,
    ),

    // ── Channels ────────────────────────────────────────────────────────
    minSeverity,
    slackWebhookUrl:
      config.get<string>('ALERT_SLACK_WEBHOOK_URL')?.trim() ?? '',
    slackMinSeverity: parseSeverity(
      config.get<string>('ALERT_SLACK_MIN_SEVERITY'),
      minSeverity,
    ),
    discordWebhookUrl:
      config.get<string>('ALERT_DISCORD_WEBHOOK_URL')?.trim() ?? '',
    discordMinSeverity: parseSeverity(
      config.get<string>('ALERT_DISCORD_MIN_SEVERITY'),
      minSeverity,
    ),
    webhookUrl: config.get<string>('ALERT_WEBHOOK_URL')?.trim() ?? '',
    webhookMinSeverity: parseSeverity(
      config.get<string>('ALERT_WEBHOOK_MIN_SEVERITY'),
      minSeverity,
    ),
    webhookAuthHeader:
      config.get<string>('ALERT_WEBHOOK_AUTH_HEADER')?.trim() ?? '',
    telegramMinSeverity: parseSeverity(
      config.get<string>('ALERT_TELEGRAM_MIN_SEVERITY'),
      minSeverity,
    ),
    webhookTimeoutMs: positiveIntEnv(
      config.get<string>('ALERT_WEBHOOK_TIMEOUT_MS'),
      DEFAULT_WEBHOOK_TIMEOUT_MS,
    ),
  };
}

/** Parse an env var where 0 is valid (unlike positiveIntEnv). */
export function nonNegativeIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}
