import type { ConfigService } from '@nestjs/config';

/**
 * Prometheus metrics configuration, resolved from environment variables in ONE
 * place so the defaults are visible and the parsing rules are shared — the same
 * pattern ops.config.ts uses for the Bull Board / queue-monitor settings.
 *
 * Every value has a safe default: with no new env vars set, metrics are ENABLED
 * at `/metrics`. That is the deliberate choice for an observability endpoint —
 * it exposes no business data (only counters, gauges and histograms), and a
 * metrics endpoint that has to be remembered at deploy time is a metrics
 * endpoint that is missing during the incident you needed it for.
 *
 * Authentication is intentionally NOT handled here: the endpoint is meant to be
 * scraped by Prometheus on the private network and protected at the edge (Nginx
 * allow/deny or basic auth), exactly like the Phase A brief specifies.
 */

/**
 * Parse a boolean env var that defaults to ON.
 *
 * Deliberately asymmetric with ops.config.ts's `boolEnv`, and for the opposite
 * reason. There, a value gates EXPOSING a dashboard, so anything that isn't a
 * clear "true" must fail closed. Here it gates OBSERVING our own process: the
 * dangerous failure is going silently blind, so only an explicit, unambiguous
 * "false" (or "0"/"no") turns metrics off. `METRICS_ENABLED=1` meaning
 * "disabled" would be a genuinely surprising trap.
 */
const FALSEY = new Set(['false', '0', 'no', 'off']);

export function boolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return !FALSEY.has(raw.trim().toLowerCase());
}

export interface MetricsConfig {
  /** Whether the /metrics route is mounted and collectors run at all. */
  enabled: boolean;
  /** Route path the registry is exposed on, always leading-slashed. */
  path: string;
  /** Prefix applied to every metric name, so all series group under one app. */
  prefix: string;
  /** Whether to collect BullMQ queue counts when a scrape arrives. */
  queueMetricsEnabled: boolean;
}

export const DEFAULT_METRICS_PATH = '/metrics';
export const DEFAULT_METRICS_PREFIX = 'mator_';

/**
 * Normalize a configured path to a single leading slash and no trailing slash,
 * so `metrics`, `/metrics` and `/metrics/` all resolve to the same route. An
 * empty/whitespace value falls back to the default rather than mounting at `/`.
 */
export function normalizeMetricsPath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return DEFAULT_METRICS_PATH;
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailing = withLeading.replace(/\/+$/, '');
  return withoutTrailing === '' ? DEFAULT_METRICS_PATH : withoutTrailing;
}

/**
 * A Prometheus metric name must match [a-zA-Z_:][a-zA-Z0-9_:]*. A prefix that
 * would produce an invalid name is rejected in favour of the default rather
 * than letting prom-client throw at registration time (i.e. at boot).
 */
export function normalizeMetricsPrefix(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return DEFAULT_METRICS_PREFIX;
  return /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(trimmed)
    ? trimmed
    : DEFAULT_METRICS_PREFIX;
}

export function resolveMetricsConfig(
  config: Pick<ConfigService, 'get'>,
): MetricsConfig {
  return {
    enabled: boolEnv(config.get<string>('METRICS_ENABLED'), true),
    path: normalizeMetricsPath(config.get<string>('METRICS_PATH')),
    prefix: normalizeMetricsPrefix(config.get<string>('METRICS_PREFIX')),
    queueMetricsEnabled: boolEnv(
      config.get<string>('METRICS_QUEUE_ENABLED'),
      true,
    ),
  };
}

/**
 * Duration buckets (seconds) for HTTP request latency. Chosen for an API whose
 * healthy responses are tens of milliseconds: dense resolution below 500ms
 * where the real distribution lives, then coarse buckets out to 10s to catch
 * the pathological tail without wasting cardinality.
 */
export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/**
 * Duration buckets (seconds) for generic background jobs (SMS delivery, push
 * fan-out, the maintenance sweep). These are network calls to an aggregator or
 * a push gateway: healthy is well under a second, and anything past ~30s is
 * already a timeout rather than a slow success.
 */
export const JOB_DURATION_BUCKETS = [0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120];

/**
 * Duration buckets (seconds) for the IMAGE pipeline specifically — deliberately
 * wider and denser in the tail than JOB_DURATION_BUCKETS.
 *
 * One image job is: download from Telegram → upload the original to Cloudinary
 * → download it back → run FLUX → upload the result. FLUX alone is routinely
 * tens of seconds, so a histogram topping out at 120s would pile most of the
 * interesting distribution into `+Inf`, where a p95 can no longer be
 * interpolated — the exact quantile you need during an incident becomes
 * unreadable. Extending to 300s keeps the slow tail measurable, and the extra
 * resolution at 45/90/180 is where the "FLUX is degraded" signal actually lives.
 *
 * 13 buckets per label value is a deliberate, bounded cost: `result` has only
 * two values (success/failure), so this is 30 series total including sum/count.
 */
export const IMAGE_DURATION_BUCKETS = [
  0.5, 1, 2, 5, 10, 20, 30, 45, 60, 90, 120, 180, 300,
];
