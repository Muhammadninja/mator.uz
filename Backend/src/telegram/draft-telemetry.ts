import { Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';

/**
 * DraftTelemetry — the ONE place the draft flow emits observability.
 *
 * It produces two things per event, both via the Nest Logger (no Prometheus /
 * Grafana yet — just well-shaped log lines that are trivial to replace later):
 *   • a STRUCTURED EVENT log — a stable message name plus a small JSON context
 *     (draftId / imageId / sellerId / jobId, whichever apply). Grep-able and
 *     ready for a log-based metrics pipeline.
 *   • a METRIC POINT — a counter-style line `metric=<name>` under a dedicated
 *     'DraftMetrics' logger, AND (as of Phase A) an increment on the matching
 *     Prometheus counter. The seam anticipated by the original design paid off:
 *     wiring a real metrics client meant editing only this class, because every
 *     draft/image call site already routed through `metric(...)`.
 *
 * Deliberately logs ONLY the identifiers above — never image bytes, URLs, tokens,
 * or seller PII.
 */

/** Metric names (counter-style). Kept as constants so call sites can't typo them. */
export const DraftMetric = {
  DRAFT_CREATED: 'draft.created',
  DRAFT_EXPIRED: 'draft.expired',
  DRAFT_PUBLISHED: 'draft.published',
  DRAFT_PREVIEW_EMITTED: 'draft.preview.emitted',
  IMAGE_QUEUED: 'image.processing.queued',
  IMAGE_STARTED: 'image.processing.started',
  IMAGE_COMPLETED: 'image.processing.completed',
  IMAGE_FAILED: 'image.processing.failed',
} as const;

export type DraftMetricName = (typeof DraftMetric)[keyof typeof DraftMetric];

/** Identifier context attached to a structured event (all optional). */
export interface DraftLogContext {
  draftId?: string;
  imageId?: string;
  sellerId?: number;
  jobId?: string;
}

@Injectable()
export class DraftTelemetry {
  private readonly events = new Logger('DraftFlow');
  private readonly metrics = new Logger('DraftMetrics');

  /**
   * The Prometheus client. `@Optional()` so every existing unit test that
   * constructs `new DraftTelemetry()` with no arguments keeps working unchanged
   * — the counters simply aren't incremented there. In the running app the
   * global MetricsModule always satisfies it.
   */
  constructor(@Optional() private readonly prom?: MetricsService) {}

  // Observability MUST NOT affect the business flow: every emit is wrapped so a
  // logging/serialization/metrics-client failure can never throw into a call site
  // (e.g. right after the product write in finalizePublishedDraft). This matters
  // more once `metric` is swapped for a real client that does network I/O.

  /**
   * Emit a structured lifecycle event: a stable `event=<name>` message with its id
   * context as compact JSON. Use for the human-readable trace of a draft's journey
   * (Draft created, Image queued, Original stored, FLUX started/finished, …).
   */
  event(name: string, ctx: DraftLogContext = {}): void {
    try {
      this.events.log(`event=${name} ${this.format(ctx)}`);
    } catch {
      // Never let observability break the flow.
    }
  }

  /**
   * Emit a metric point (counter). Swap the body for a real metrics client later —
   * every call site already passes the right dimensions.
   */
  metric(name: DraftMetricName, ctx: DraftLogContext = {}): void {
    try {
      this.metrics.log(`metric=${name} ${this.format(ctx)}`);
      this.toPrometheus(name);
    } catch {
      // Never let observability break the flow.
    }
  }

  /**
   * Map a draft metric point onto its Prometheus counter.
   *
   * Only the metrics with a defined business counter are mapped; the rest stay
   * log-only (a metric nobody has agreed to alert on is a series nobody reads).
   * Image duration is NOT recorded here — a counter call site has no notion of
   * elapsed time; the image worker observes that histogram itself, where the
   * start and end of the work are both in scope.
   */
  private toPrometheus(name: DraftMetricName): void {
    if (!this.prom) return;
    switch (name) {
      case DraftMetric.DRAFT_CREATED:
        this.prom.recordDraftCreated();
        break;
      case DraftMetric.DRAFT_PUBLISHED:
        this.prom.recordProductPublished();
        break;
      case DraftMetric.DRAFT_EXPIRED:
        this.prom.recordDraftExpired();
        break;
      default:
        // Preview/image lifecycle points remain log-only.
        break;
    }
  }

  /** Compact, stable-order JSON of only the present id fields. */
  private format(ctx: DraftLogContext): string {
    const out: Record<string, string | number> = {};
    if (ctx.draftId !== undefined) out.draftId = ctx.draftId;
    if (ctx.imageId !== undefined) out.imageId = ctx.imageId;
    if (ctx.sellerId !== undefined) out.sellerId = ctx.sellerId;
    if (ctx.jobId !== undefined) out.jobId = ctx.jobId;
    return JSON.stringify(out);
  }
}
