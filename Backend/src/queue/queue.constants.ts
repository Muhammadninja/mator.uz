import type { JobsOptions } from 'bullmq';

/**
 * Canonical BullMQ queue names. Every queue registration, every producer
 * (QueueService) and every worker (Processor) references these constants —
 * never a raw string literal. A typo in a queue name silently creates a second,
 * orphaned queue that nothing consumes, so the name lives in exactly one place.
 *
 * These are infrastructure only. Registering a queue here does NOT move any
 * business logic onto it — see QueueService for the (currently placeholder)
 * producers and QUEUE.md-equivalent notes in the PR description for the
 * migration plan.
 */
export const QUEUE_NAMES = {
  /** Off-request image processing (resize/optimize/upload). Not yet a consumer of the real pipeline. */
  IMAGE_PROCESSING: 'image-processing',
  /** Outbound SMS delivery. Not yet a consumer of the real SMS sender. */
  SMS: 'sms',
  /** Fan-out notifications (push/realtime/email). Not yet a consumer of the real notifier. */
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
 * Retention — keep the queue from growing without bound:
 *   • removeOnComplete: keep the last 1 000 successes (for observability), drop
 *                       anything older or beyond 24h.
 *   • removeOnFail:     keep the last 5 000 failures for 7 days so they can be
 *                       inspected/retried, then let them age out automatically.
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
    age: 7 * 24 * 60 * 60, // 7 days
    count: 5_000,
  },
};

// ── Image worker concurrency ────────────────────────────────────────────────
// How many image-processing jobs the worker runs at once. This is what actually
// makes an album's photos process in PARALLEL (the enqueue is per-job, but a
// concurrency=1 worker would drain them one at a time). Bounded so we don't hammer
// FLUX/Cloudinary or spike memory with many large image buffers simultaneously.
export const IMAGE_WORKER_CONCURRENCY_DEFAULT = 5;
const IMAGE_WORKER_CONCURRENCY_MIN = 1;
const IMAGE_WORKER_CONCURRENCY_MAX = 10;

/**
 * Resolve the image worker's concurrency from a raw env value (IMAGE_CONCURRENCY).
 * Accepts an integer in [MIN, MAX]; anything missing / non-integer / out of range
 * falls back to the default. Read from `process.env` directly (not ConfigService)
 * because the `@Processor` decorator's worker options are evaluated at class-load
 * time, before Nest DI is available. Same bounds/semantics as the legacy album
 * pool's resolver, so switching flows keeps identical throughput.
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
