import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { MetricsConfig } from './metrics.config';
import { METRICS_CONFIG } from './metrics.providers';
import { MetricsService, UNKNOWN_LABEL } from './metrics.service';

/**
 * Publishes the accounted SMS spend into the registry.
 *
 * ── Reuses the existing accounting, computes nothing new ──
 * SmsService already snapshots the operator name and price onto every accepted
 * send (`sms_messages.operator_name` / `price_uzs`, frozen at send time so later
 * price edits never rewrite history — see the SmsMessage model). This collector
 * is READ-ONLY over that table: one `groupBy(operatorName) _sum(priceUzs)` and
 * the numbers are the DB's, not ours. No accounting logic is touched, no column
 * is added, and the cost is never recomputed from SmsOperator.
 *
 * ── Grouped by mobile operator, not by gateway provider ──
 * Spend is reported per NETWORK (beeline, ucell, …) because that is what sets
 * the per-SMS price; which aggregator carried the message is a delivery detail
 * tracked by the sent/failed counters instead. Sends whose operator could not
 * be resolved are reported as "unknown" rather than dropped, so the
 * per-operator series always re-sums to `mator_sms_cost_uzs`.
 *
 * PULL, NOT POLL — the same contract as QueueMetricsCollector: `collect()` runs
 * when Prometheus scrapes, so the aggregate is computed as often as it is
 * actually consumed (every 15–30s) and not at all when nobody is scraping.
 *
 * ── Why a full-table aggregate is affordable ──
 * `SUM` over `sms_messages` grouped by a 40-char `provider` is a single
 * sequential scan of a narrow table that grows at OTP volume (thousands/day, not
 * millions). At that size it is sub-millisecond and cheaper than the Redis round
 * trips the queue collector already makes on the same request. If the table ever
 * outgrows that, the fix is a rollup table — not a Counter in process memory,
 * which would lose spend on every deploy.
 */
@Injectable()
export class SmsCostCollector {
  private readonly logger = new Logger(SmsCostCollector.name);
  /** Log a collection failure once — a scrape every 15s must not spam the log. */
  private warned = false;

  constructor(
    private readonly metrics: MetricsService,
    @Inject(METRICS_CONFIG) private readonly config: MetricsConfig,
    // Optional for the same reason the queue collector's queues are: the module
    // must construct in a unit test (and in any DB-less context) without a live
    // Prisma connection. PrismaModule is @Global, so the app always supplies it.
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /**
   * Aggregate the accounting table and write the results into the gauges.
   *
   * Never throws and never rejects: a DB hiccup during a scrape must still yield
   * a 200 with the rest of the metrics intact. On failure the gauges keep their
   * previous values, which Prometheus renders as a flat line — visibly stale
   * rather than a broken scrape that loses everything.
   */
  async collect(): Promise<void> {
    if (!this.config.enabled || !this.config.smsCostMetricsEnabled) return;
    if (!this.prisma) return;

    try {
      const grouped = await this.prisma.smsMessage.groupBy({
        by: ['operatorName'],
        _sum: { priceUzs: true },
      });

      // Fold the per-operator sums into the overall total in the same pass, so
      // the two metrics are guaranteed consistent and nothing is summed twice.
      // `_sum` is null when every row in a group has a NULL price (operator
      // unresolved at send time); such sends contribute 0, not NaN.
      //
      // Accumulate with `+=` rather than assigning: operatorName is nullable,
      // so NULL and any blank-ish name are DISTINCT groups in SQL that all
      // collapse onto the same "unknown" label. Overwriting would silently
      // drop every group but the last and make the per-operator series stop
      // re-summing to the total.
      const perOperator: Record<string, number> = {};
      let total = 0;
      for (const row of grouped) {
        const uzs = row._sum.priceUzs ?? 0;
        // Normalise here as well as in MetricsService.label() so the merge
        // above keys on exactly the label that will be exported.
        const operator = (row.operatorName ?? '').trim() || UNKNOWN_LABEL;
        perOperator[operator] = (perOperator[operator] ?? 0) + uzs;
        total += uzs;
      }

      this.metrics.setSmsCost(perOperator, total);
      this.warned = false;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          `Failed to collect SMS cost metrics (further failures suppressed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
