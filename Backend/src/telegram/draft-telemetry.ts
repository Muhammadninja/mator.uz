import { Injectable, Logger } from '@nestjs/common';

/**
 * DraftTelemetry — the ONE place the parallel draft flow emits observability.
 *
 * It produces two things per event, both via the Nest Logger (no Prometheus /
 * Grafana yet — just well-shaped log lines that are trivial to replace later):
 *   • a STRUCTURED EVENT log — a stable message name plus a small JSON context
 *     (draftId / imageId / sellerId / jobId, whichever apply). Grep-able and
 *     ready for a log-based metrics pipeline.
 *   • a METRIC POINT — a counter-style line `metric=<name>` under a dedicated
 *     'DraftMetrics' logger, so swapping in a real metrics client later means
 *     changing only this class (find every `metric(...)` call site → one file).
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
   * Emit a structured lifecycle event: a stable `event=<name>` message with its id
   * context as compact JSON. Use for the human-readable trace of a draft's journey
   * (Draft created, Image queued, Original stored, FLUX started/finished, …).
   */
  event(name: string, ctx: DraftLogContext = {}): void {
    this.events.log(`event=${name} ${this.format(ctx)}`);
  }

  /**
   * Emit a metric point (counter). Swap the body for a real metrics client later —
   * every call site already passes the right dimensions.
   */
  metric(name: DraftMetricName, ctx: DraftLogContext = {}): void {
    this.metrics.log(`metric=${name} ${this.format(ctx)}`);
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
