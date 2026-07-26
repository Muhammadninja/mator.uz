import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import {
  HTTP_DURATION_BUCKETS,
  IMAGE_DURATION_BUCKETS,
  JOB_DURATION_BUCKETS,
  type MetricsConfig,
} from './metrics.config';

/**
 * THE single place every metric in the app is defined.
 *
 * Nothing outside this file constructs a Counter/Gauge/Histogram. Call sites go
 * through MetricsService, which reads from the `AppMetrics` bundle built here.
 * That keeps names, labels and bucket choices reviewable in one diff and makes
 * "is this metric already defined?" a question with a single place to look.
 *
 * ── Why an explicitly-passed Registry rather than prom-client's global one ──
 * prom-client ships a process-global default registry. Using it would make the
 * metric set global mutable state: two Nest test modules in the same Jest worker
 * would both register `mator_http_requests_total` against it and the second
 * would throw "A metric with the name … has already been registered", so tests
 * would pass or fail depending on file order. Instead each MetricsModule owns
 * ONE Registry instance created by DI (see metrics.providers.ts) and every
 * metric is bound to it via `registers: [registry]`. The registry is the only
 * piece of shared mutable state in this module, which is exactly the exception
 * the brief allows.
 */

/** Every metric object the app can touch, constructed once per registry. */
export interface AppMetrics {
  // ── HTTP ────────────────────────────────────────────────────────────────
  /** Total finished HTTP requests, by method / route / status_code. */
  httpRequestsTotal: Counter<'method' | 'route' | 'status_code'>;
  /** Request latency in seconds, same labels as the counter. */
  httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  /** Requests currently being served (an in-flight gauge). */
  httpRequestsInFlight: Gauge<'method'>;

  // ── BullMQ ──────────────────────────────────────────────────────────────
  /** Jobs per queue per state (waiting/active/delayed/completed/failed/paused). */
  queueJobs: Gauge<'queue' | 'state'>;
  /** Workers currently attached to a queue. */
  queueWorkers: Gauge<'queue'>;
  /** Terminal job outcomes observed by the app, by queue and result. */
  queueJobsProcessedTotal: Counter<'queue' | 'result'>;
  /** How long a job took to process, in seconds. */
  queueJobDuration: Histogram<'queue' | 'result'>;

  // ── Business ────────────────────────────────────────────────────────────
  /** Product drafts created (a seller started the listing wizard). */
  draftsCreatedTotal: Counter<string>;
  /** Drafts that reached PUBLISHED — i.e. products published. */
  productsPublishedTotal: Counter<string>;
  /** Drafts swept away by the TTL cleanup without ever publishing. */
  draftsExpiredTotal: Counter<string>;
  /** SMS accepted by a provider, by provider name and template. */
  smsSentTotal: Counter<'provider' | 'template'>;
  /** SMS that failed to send, by provider and coarse reason. */
  smsFailedTotal: Counter<'provider' | 'template' | 'reason'>;
  /**
   * Cumulative accounted SMS spend in UZS per MOBILE OPERATOR (beeline,
   * ucell, …), read from the SMS accounting table at scrape time. A GAUGE, not
   * a counter — see below.
   */
  smsOperatorCostUzs: Gauge<'operator'>;
  /** Cumulative accounted SMS spend in UZS across all operators. */
  smsCostUzs: Gauge<string>;
  /** End-to-end image processing wall time in seconds, by outcome. */
  imageProcessingDuration: Histogram<'result'>;
  /** Image jobs by terminal outcome — the counter beside the histogram. */
  imageProcessingTotal: Counter<'result'>;
}

/**
 * Construct every metric against `registry`.
 *
 * Safe to call once per registry. Calling it twice with the SAME registry
 * throws (prom-client rejects duplicate names) — which is the desired
 * behaviour: it turns an accidental double-registration into a loud boot
 * failure rather than silently split series. MetricsModule guarantees one call
 * by binding this to a single DI provider (module-scoped singleton).
 */
export function createAppMetrics(
  registry: Registry,
  config: MetricsConfig,
): AppMetrics {
  const { prefix } = config;
  const registers = [registry];

  return {
    // ── HTTP ──────────────────────────────────────────────────────────────
    httpRequestsTotal: new Counter({
      name: `${prefix}http_requests_total`,
      help: 'Total number of HTTP requests handled, by method, route and status code.',
      labelNames: ['method', 'route', 'status_code'] as const,
      registers,
    }),
    httpRequestDuration: new Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: 'HTTP request duration in seconds.',
      labelNames: ['method', 'route', 'status_code'] as const,
      buckets: HTTP_DURATION_BUCKETS,
      registers,
    }),
    httpRequestsInFlight: new Gauge({
      name: `${prefix}http_requests_in_flight`,
      help: 'Number of HTTP requests currently being processed.',
      labelNames: ['method'] as const,
      registers,
    }),

    // ── BullMQ ────────────────────────────────────────────────────────────
    // A gauge (not a counter) because these are point-in-time depths read from
    // Redis at scrape time. `completed`/`failed` are BullMQ's retained-set sizes
    // and are bounded by the removeOnComplete/removeOnFail policy in
    // queue.constants.ts — for a monotonic total use queueJobsProcessedTotal.
    queueJobs: new Gauge({
      name: `${prefix}bullmq_jobs`,
      help: 'Number of BullMQ jobs per queue and state, sampled at scrape time.',
      labelNames: ['queue', 'state'] as const,
      registers,
    }),
    queueWorkers: new Gauge({
      name: `${prefix}bullmq_workers`,
      help: 'Number of workers currently attached to a BullMQ queue.',
      labelNames: ['queue'] as const,
      registers,
    }),
    queueJobsProcessedTotal: new Counter({
      name: `${prefix}bullmq_jobs_processed_total`,
      help: 'Terminal BullMQ job outcomes observed by this process, by queue and result.',
      labelNames: ['queue', 'result'] as const,
      registers,
    }),
    // One histogram means ONE bucket set shared by all four queues, so these
    // buckets are tuned for the short-job majority (SMS, push, maintenance).
    // Image jobs legitimately exceed the 120s top bucket; for that pipeline read
    // `image_processing_duration_seconds`, which has its own wider buckets.
    // Widening these to suit images would cost every other queue the sub-second
    // resolution where its real distribution lives.
    queueJobDuration: new Histogram({
      name: `${prefix}bullmq_job_duration_seconds`,
      help: 'BullMQ job processing duration in seconds, by queue and result. Note: buckets are tuned for short jobs; use image_processing_duration_seconds for the image pipeline.',
      labelNames: ['queue', 'result'] as const,
      buckets: JOB_DURATION_BUCKETS,
      registers,
    }),

    // ── Business ──────────────────────────────────────────────────────────
    draftsCreatedTotal: new Counter({
      name: `${prefix}drafts_created_total`,
      help: 'Total product drafts created.',
      registers,
    }),
    productsPublishedTotal: new Counter({
      name: `${prefix}products_published_total`,
      help: 'Total product drafts published as live products.',
      registers,
    }),
    draftsExpiredTotal: new Counter({
      name: `${prefix}drafts_expired_total`,
      help: 'Total product drafts expired by the TTL sweep without publishing.',
      registers,
    }),
    smsSentTotal: new Counter({
      name: `${prefix}sms_sent_total`,
      help: 'Total SMS messages accepted by a provider.',
      labelNames: ['provider', 'template'] as const,
      registers,
    }),
    smsFailedTotal: new Counter({
      name: `${prefix}sms_failed_total`,
      help: 'Total SMS messages that failed to send.',
      labelNames: ['provider', 'template', 'reason'] as const,
      registers,
    }),
    // ── SMS cost ──────────────────────────────────────────────────────────
    // GAUGES, even though the value is monotonic in practice. It is not
    // accumulated by this process: it is the SUM of `sms_messages.price_uzs`
    // read straight from Postgres on each scrape, so the DB — not process
    // memory — is the source of truth. A Counter would be wrong twice over: it
    // would reset to 0 on every deploy (losing spend a restart cannot un-spend),
    // and under PM2 cluster mode each instance would accumulate only the sends
    // it happened to serve. As a gauge, every instance reports the same DB-wide
    // figure, which is why the dashboard aggregates these with `max` and never
    // `sum` (the same rule the BullMQ gauges follow).
    //
    // ── Why no `_total` suffix ──
    // By Prometheus convention `_total` marks a COUNTER, and tooling leans on
    // that: promtool's lint and the exporter guidelines both read it as a
    // monotonic cumulative counter, and a `_total` gauge invites someone to
    // reach for rate()/increase() — which is meaningless here. The name carries
    // only the unit (`_uzs`); "cumulative to date" lives in the help text and
    // the dashboard panel descriptions instead.
    //
    // ── Grouped by MOBILE OPERATOR, not by gateway provider ──
    // The label is `sms_messages.operator_name` (beeline, ucell, …) — the
    // network that actually sets the price — not the aggregator that carried
    // the send. Sends whose operator could not be resolved report as
    // `operator="unknown"` rather than being dropped, so the per-operator
    // series always re-sums to the overall total.
    //
    // Rows with a NULL price_uzs (operator unresolved at send time) contribute
    // nothing — see SmsCostCollector.
    smsOperatorCostUzs: new Gauge({
      name: `${prefix}sms_operator_cost_uzs`,
      help: 'Cumulative accounted SMS cost in UZS to date, per mobile operator (from sms_messages.operator_name; "unknown" when unresolved), summed from the SMS accounting table at scrape time.',
      labelNames: ['operator'] as const,
      registers,
    }),
    smsCostUzs: new Gauge({
      name: `${prefix}sms_cost_uzs`,
      help: 'Cumulative accounted SMS cost in UZS to date across all mobile operators (the sum of mator_sms_operator_cost_uzs).',
      registers,
    }),

    // Wider buckets than the generic queue histogram: FLUX + two Cloudinary
    // round trips routinely run tens of seconds. See IMAGE_DURATION_BUCKETS.
    imageProcessingDuration: new Histogram({
      name: `${prefix}image_processing_duration_seconds`,
      help: 'End-to-end image processing duration in seconds, by outcome.',
      labelNames: ['result'] as const,
      buckets: IMAGE_DURATION_BUCKETS,
      registers,
    }),
    imageProcessingTotal: new Counter({
      name: `${prefix}image_processing_total`,
      help: 'Total image processing jobs by terminal outcome.',
      labelNames: ['result'] as const,
      registers,
    }),
  };
}

/**
 * Register prom-client's standard Node.js collectors against `registry`:
 * process CPU (user/system seconds), resident memory, V8 heap size/used by
 * space, event-loop lag (mean/percentiles), active handles/requests, GC
 * duration and process start time — from which uptime is derived.
 *
 * These are pull-based: prom-client reads them when the registry is scraped,
 * so there is no background polling loop. The one exception is event-loop lag,
 * which prom-client samples on its own small timer; that timer is unref'd by
 * prom-client, so it never holds the process open at shutdown.
 */
export function registerDefaultMetrics(
  registry: Registry,
  config: MetricsConfig,
): void {
  collectDefaultMetrics({ register: registry, prefix: config.prefix });
}
