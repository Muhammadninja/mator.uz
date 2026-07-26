import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Registry } from 'prom-client';
import type { MetricsConfig } from './metrics.config';
import type { AppMetrics } from './metrics.definitions';
import {
  APP_METRICS,
  METRICS_CONFIG,
  METRICS_REGISTRY,
} from './metrics.providers';

/**
 * The ONLY interface the rest of the app uses to record metrics.
 *
 * Two rules govern every method here, both inherited from the way DraftTelemetry
 * already treats observability in this codebase:
 *
 *   1. NEVER THROW. Instrumentation sits inline in business paths — right after
 *      a product write, inside an SMS worker. A bad label value or a
 *      prom-client edge case must degrade the metric, never the flow. Every
 *      public method is wrapped in `safe()`.
 *   2. BOUNDED CARDINALITY. Labels are normalized before they reach the
 *      registry: unknown/absent values collapse to a fixed sentinel and free-form
 *      strings (provider error messages, route paths) are never used raw. An
 *      unbounded label is the one way a metrics endpoint can take down the
 *      process it is observing.
 */

/** Sentinel used wherever a label value is missing or unrecognised. */
export const UNKNOWN_LABEL = 'unknown';

/** Terminal outcome of a unit of background work. */
export type JobResult = 'success' | 'failure';

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  /** Log a metrics failure at most once — a broken metric must not spam logs. */
  private warned = false;

  constructor(
    @Inject(APP_METRICS) private readonly metrics: AppMetrics,
    @Inject(METRICS_REGISTRY) private readonly registry: Registry,
    @Inject(METRICS_CONFIG) private readonly config: MetricsConfig,
  ) {}

  /** Whether metrics collection/exposure is turned on (METRICS_ENABLED). */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** The Prometheus exposition text for a scrape. */
  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  /** The registry's content type header value (`text/plain; version=0.0.4; …`). */
  get contentType(): string {
    return this.registry.contentType;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  /** A request started. Paired with `observeHttpRequest` when it finishes. */
  startHttpRequest(method: string): void {
    this.safe(() =>
      this.metrics.httpRequestsInFlight.inc({
        method: normalizeMethod(method),
      }),
    );
  }

  /**
   * A request finished: bump the total, observe its duration, and release the
   * in-flight slot. `route` must already be a low-cardinality template (e.g.
   * `/v1/orders/:id`), which the interceptor guarantees.
   */
  observeHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    this.safe(() => {
      const labels = {
        method: normalizeMethod(method),
        route,
        status_code: String(statusCode),
      };
      this.metrics.httpRequestsTotal.inc(labels);
      this.metrics.httpRequestDuration.observe(labels, durationSeconds);
      this.metrics.httpRequestsInFlight.dec({ method: labels.method });
    });
  }

  // ── BullMQ ──────────────────────────────────────────────────────────────

  /**
   * Publish one queue's sampled depths. Called by the queue collector during a
   * scrape — `set` (not `inc`) because these are point-in-time gauges.
   */
  setQueueDepths(queue: string, counts: Record<string, number>): void {
    this.safe(() => {
      for (const [state, value] of Object.entries(counts)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          this.metrics.queueJobs.set({ queue, state }, value);
        }
      }
    });
  }

  /** Publish the worker count attached to a queue. */
  setQueueWorkers(queue: string, workers: number): void {
    this.safe(() => this.metrics.queueWorkers.set({ queue }, workers));
  }

  /**
   * A job reached a terminal state. `durationSeconds` is omitted when BullMQ
   * didn't give us usable timestamps, in which case only the counter moves.
   */
  observeJob(queue: string, result: JobResult, durationSeconds?: number): void {
    this.safe(() => {
      this.metrics.queueJobsProcessedTotal.inc({ queue, result });
      if (durationSeconds !== undefined && durationSeconds >= 0) {
        this.metrics.queueJobDuration.observe(
          { queue, result },
          durationSeconds,
        );
      }
    });
  }

  // ── Business ────────────────────────────────────────────────────────────

  /** A seller started a product draft. */
  recordDraftCreated(): void {
    this.safe(() => this.metrics.draftsCreatedTotal.inc());
  }

  /** A draft became a live product. */
  recordProductPublished(): void {
    this.safe(() => this.metrics.productsPublishedTotal.inc());
  }

  /** A draft was swept by the TTL cleanup without ever publishing. */
  recordDraftExpired(): void {
    this.safe(() => this.metrics.draftsExpiredTotal.inc());
  }

  /** A provider accepted an SMS. */
  recordSmsSent(provider: string, template?: string | null): void {
    this.safe(() =>
      this.metrics.smsSentTotal.inc({
        provider: label(provider),
        template: label(template),
      }),
    );
  }

  /**
   * An SMS send failed. `reason` is normalized to a small closed set — a raw
   * provider error message would blow up cardinality (see class docblock).
   */
  recordSmsFailed(
    provider: string,
    template?: string | null,
    reason?: unknown,
  ): void {
    this.safe(() =>
      this.metrics.smsFailedTotal.inc({
        provider: label(provider),
        template: label(template),
        reason: classifyFailure(reason),
      }),
    );
  }

  /**
   * Publish the accounted SMS spend read from the accounting table, grouped by
   * MOBILE OPERATOR (beeline, ucell, …) — the network that sets the price —
   * rather than by the gateway provider that carried the send.
   *
   * `set` (not `inc`) because these are gauges holding a DB-wide cumulative sum
   * re-read on every scrape — see the metrics.definitions.ts note on why a
   * counter would be wrong here.
   *
   * The per-operator gauge is RESET first so an operator that disappears from
   * the accounting table (rows pruned by retention) stops reporting a stale
   * value instead of flat-lining forever at its last reading. The total is
   * passed in rather than re-derived from the map: the collector computes it in
   * the same query pass, so nothing is calculated twice.
   *
   * A null/blank operator name becomes `operator="unknown"` via label(), so
   * unresolved sends still contribute and the per-operator series re-sums to
   * the total.
   */
  setSmsCost(perOperator: Record<string, number>, totalUzs: number): void {
    this.safe(() => {
      this.metrics.smsOperatorCostUzs.reset();
      for (const [operator, uzs] of Object.entries(perOperator)) {
        if (Number.isFinite(uzs)) {
          this.metrics.smsOperatorCostUzs.set({ operator: label(operator) }, uzs);
        }
      }
      if (Number.isFinite(totalUzs)) {
        this.metrics.smsCostUzs.set(totalUzs);
      }
    });
  }

  /** An image job finished; record its wall time and outcome. */
  observeImageProcessing(result: JobResult, durationSeconds: number): void {
    this.safe(() => {
      this.metrics.imageProcessingTotal.inc({ result });
      if (durationSeconds >= 0) {
        this.metrics.imageProcessingDuration.observe(
          { result },
          durationSeconds,
        );
      }
    });
  }

  // ── Read access (alerting) ──────────────────────────────────────────────
  //
  // The alerting rules need to READ the series they alert on. Exposing the two
  // specific metric objects they consume — rather than the whole AppMetrics
  // bundle or the registry — keeps the module's core rule intact: nothing
  // outside metrics.definitions.ts constructs a metric, and every consumer
  // still goes through this service. These are the only read accessors, and
  // both are deliberately narrow.
  //
  // Both return the CUMULATIVE prom-client object. Turning that into a rolling
  // window is the caller's job (see alerting/metric-window.ts) — a cumulative
  // reading is not directly alertable.

  /** The image-processing duration histogram, for windowed P95 evaluation. */
  get imageProcessingDurationMetric(): AppMetrics['imageProcessingDuration'] {
    return this.metrics.imageProcessingDuration;
  }

  /** The SMS failure counter, for windowed failure-rate evaluation. */
  get smsFailedMetric(): AppMetrics['smsFailedTotal'] {
    return this.metrics.smsFailedTotal;
  }

  /**
   * Run an instrumentation side effect, swallowing anything it throws. See rule
   * 1 in the class docblock: no metric is worth an exception in a business path.
   */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          `Metrics recording failed (further failures suppressed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}

/** Uppercase a known HTTP verb; anything else collapses to the sentinel. */
const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export function normalizeMethod(method: string | undefined): string {
  const upper = (method ?? '').toUpperCase();
  return HTTP_METHODS.has(upper) ? upper : UNKNOWN_LABEL;
}

/** Collapse an absent/blank label value to the sentinel. */
function label(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? UNKNOWN_LABEL : trimmed;
}

/**
 * Map an arbitrary thrown value to one of a handful of stable reason labels.
 * Deliberately coarse: the label answers "what kind of failure is spiking?",
 * and the exact message stays in the logs where it belongs.
 */
export function classifyFailure(err: unknown): string {
  const message = (
    err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  ).toLowerCase();

  if (message === '') return UNKNOWN_LABEL;
  if (message.includes('timeout') || message.includes('etimedout')) {
    return 'timeout';
  }
  if (
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('network')
  ) {
    return 'network';
  }
  if (
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('401') ||
    message.includes('403') ||
    message.includes('credential')
  ) {
    return 'auth';
  }
  if (message.includes('rate limit') || message.includes('429')) {
    return 'rate_limited';
  }
  if (message.includes('invalid') || message.includes('validation')) {
    return 'invalid_request';
  }
  return 'other';
}
