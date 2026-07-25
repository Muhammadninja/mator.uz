import type { JobsOptions } from 'bullmq';

/**
 * Canonical BullMQ queue names. Every queue registration, every producer
 * (QueueService) and every worker (Processor) references these constants —
 * never a raw string literal. A typo in a queue name silently creates a second,
 * orphaned queue that nothing consumes, so the name lives in exactly one place.
 *
 * Every queue here has a real producer and a real consumer (see queue.service.ts
 * and queue.processors.ts). Producers commit business state first and enqueue
 * only the DELIVERY/processing step.
 */
export const QUEUE_NAMES = {
  /** Off-request image processing (ingest original + FLUX enhance + upload). */
  IMAGE_PROCESSING: 'image-processing',
  /** Outbound SMS delivery — the only path that reaches an SMS provider. */
  SMS: 'sms',
  /** Push fan-out for notifications whose inbox row is already committed. */
  NOTIFICATIONS: 'notifications',
  /** Scheduled maintenance (repeatable jobs), e.g. the product-draft TTL sweep.
   *  Deliberately separate from IMAGE_PROCESSING so cleanup never mixes with the
   *  per-image work queue. */
  MAINTENANCE: 'maintenance',
} as const;

/**
 * Named jobs on the MAINTENANCE queue. `DRAFT_CLEANUP` is scheduled once as a
 * repeatable job (see DEFAULT_DRAFT_CLEANUP_EVERY_MS) and sweeps expired product
 * drafts: deletes their Cloudinary assets, removes any unfinished image jobs, and
 * marks them EXPIRED.
 */
export const MAINTENANCE_JOBS = {
  DRAFT_CLEANUP: 'draft-cleanup',
} as const;

/** How often the draft-cleanup sweep runs (hourly). */
export const DEFAULT_DRAFT_CLEANUP_EVERY_MS = 60 * 60 * 1000;

/**
 * Union of the concrete queue-name string literals, e.g. `'image-processing'`.
 * Use where a value must be one of the registered queues.
 */
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Default per-job options applied to every queue at registration time.
 *
 * Retry policy — deliberately bounded, never infinite:
 *   • attempts: 3        → the original try plus 2 retries, then the job fails
 *                          for good and lands in the failed set (no silent loop).
 *   • backoff: exponential, 2s base → waits ~2s, ~4s, ~8s between attempts, so a
 *                          transient dependency blip is absorbed without hammering.
 *
 * Retention — bounded on BOTH age and count, so failures survive long enough to
 * debug without ever growing unbounded (whichever limit is hit first wins):
 *   • removeOnComplete: keep the last 1 000 successes (for observability), drop
 *                       anything older or beyond 24h.
 *   • removeOnFail:     keep the last 5 000 failures for 7 days so they can be
 *                       inspected/retried in Bull Board, then let them age out
 *                       automatically. Seven days spans a weekend plus a working
 *                       day, so a Friday-night failure is still there on Monday.
 *
 * Failed-job retention is env-tunable (QUEUE_FAILED_RETENTION_DAYS /
 * QUEUE_FAILED_RETENTION_COUNT) so an incident can widen the window without a
 * deploy. Both remain bounded: a zero/invalid value falls back to the default
 * rather than meaning "unlimited".
 *
 * These are defaults: a specific producer may override per-enqueue (e.g. a
 * deterministic jobId, a different attempt count) via QueueService.
 *
 * The retry count and backoff base are env-configurable (IMAGE_QUEUE_RETRIES /
 * IMAGE_QUEUE_BACKOFF_MS) so ops can tune them without a code change; the built-in
 * values below are the defaults. Read from process.env because this object is
 * consumed at module registration time (BullModule.forRootAsync's factory runs
 * later, but this constant is imported directly), before DI is available.
 */
const DEFAULT_QUEUE_RETRIES = 3;
const DEFAULT_QUEUE_BACKOFF_MS = 2_000;
const DEFAULT_FAILED_RETENTION_DAYS = 7;
const DEFAULT_FAILED_RETENTION_COUNT = 5_000;

/** Parse a positive-integer env var, falling back to `fallback` when unset/invalid. */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: positiveIntEnv(
    process.env.IMAGE_QUEUE_RETRIES,
    DEFAULT_QUEUE_RETRIES,
  ),
  backoff: {
    type: 'exponential',
    delay: positiveIntEnv(
      process.env.IMAGE_QUEUE_BACKOFF_MS,
      DEFAULT_QUEUE_BACKOFF_MS,
    ),
  },
  removeOnComplete: {
    age: 24 * 60 * 60, // 24h
    count: 1_000,
  },
  removeOnFail: {
    age:
      positiveIntEnv(
        process.env.QUEUE_FAILED_RETENTION_DAYS,
        DEFAULT_FAILED_RETENTION_DAYS,
      ) *
      24 *
      60 *
      60,
    count: positiveIntEnv(
      process.env.QUEUE_FAILED_RETENTION_COUNT,
      DEFAULT_FAILED_RETENTION_COUNT,
    ),
  },
};

// ── Image worker concurrency ────────────────────────────────────────────────
// How many image-processing jobs the worker runs at once. This is what makes an
// album's photos process concurrently (the enqueue is per-job, but a concurrency=1
// worker would drain them one at a time). Bounded so we don't hammer FLUX/Cloudinary
// or spike memory with many large image buffers simultaneously.
export const IMAGE_WORKER_CONCURRENCY_DEFAULT = 5;
const IMAGE_WORKER_CONCURRENCY_MIN = 1;
const IMAGE_WORKER_CONCURRENCY_MAX = 10;

/**
 * Resolve the image worker's concurrency from a raw env value (IMAGE_CONCURRENCY).
 * Accepts an integer in [MIN, MAX]; anything missing / non-integer / out of range
 * falls back to the default. Read from `process.env` directly (not ConfigService)
 * because the `@Processor` decorator's worker options are evaluated at class-load
 * time, before Nest DI is available.
 */
export function resolveImageWorkerConcurrency(
  raw: string | undefined = process.env.IMAGE_CONCURRENCY,
): number {
  if (raw === undefined || raw.trim() === '') {
    return IMAGE_WORKER_CONCURRENCY_DEFAULT;
  }
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < IMAGE_WORKER_CONCURRENCY_MIN ||
    value > IMAGE_WORKER_CONCURRENCY_MAX
  ) {
    return IMAGE_WORKER_CONCURRENCY_DEFAULT;
  }
  return value;
}

// ── SMS worker concurrency ──────────────────────────────────────────────────
// Deliberately much lower than the image worker: SMS aggregators rate-limit per
// account, so bounded concurrency here doubles as a crude outbound throttle and
// keeps us from tripping provider-side limits during an OTP burst. Same
// class-load-time constraint as the image worker (see @Processor note there),
// hence process.env rather than ConfigService.
export const SMS_WORKER_CONCURRENCY_DEFAULT = 3;
const SMS_WORKER_CONCURRENCY_MIN = 1;
const SMS_WORKER_CONCURRENCY_MAX = 20;

/**
 * Resolve the SMS worker's concurrency from a raw env value (SMS_CONCURRENCY).
 * Accepts an integer in [MIN, MAX]; anything missing / non-integer / out of range
 * falls back to the default.
 */
export function resolveSmsWorkerConcurrency(
  raw: string | undefined = process.env.SMS_CONCURRENCY,
): number {
  if (raw === undefined || raw.trim() === '') {
    return SMS_WORKER_CONCURRENCY_DEFAULT;
  }
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < SMS_WORKER_CONCURRENCY_MIN ||
    value > SMS_WORKER_CONCURRENCY_MAX
  ) {
    return SMS_WORKER_CONCURRENCY_DEFAULT;
  }
  return value;
}
