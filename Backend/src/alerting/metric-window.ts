import type { Counter, Histogram } from 'prom-client';

/**
 * Windowed reads over prom-client metrics.
 *
 * ── The problem this solves ──
 * prom-client counters and histograms are CUMULATIVE since process start. Read
 * naively, "SMS failures" is every failure since boot, and a P95 over all-time
 * is dominated by history: after one bad hour the alert would fire forever, and
 * after a long healthy period a genuine outage would be invisible under the
 * weight of past good samples. Neither recovers, so neither is alertable.
 *
 * PromQL solves this with `rate()` / `increase()` — it stores samples over time
 * and differences them. Prometheus is already scraping this app, but the brief
 * requires alerting to work from application-level state, not from querying
 * Prometheus back. So this file does the same arithmetic in-process: keep the
 * previous reading, subtract it from the current one, and interpret the DELTA.
 *
 * That is exactly `increase(metric[window])`, and for histograms
 * `histogram_quantile(0.95, rate(..._bucket[window]))` — the standard recipe,
 * computed locally.
 *
 * ── Counter resets ──
 * A negative delta means the process restarted (counters reset to 0). Treated
 * as "the current value is the delta", matching Prometheus's own reset
 * handling, so a deploy never produces a nonsense negative rate.
 */

/** Cumulative bucket counts keyed by their `le` upper bound, plus the total. */
export interface HistogramSnapshot {
  /** Upper bound (seconds) → cumulative observation count at/below it. */
  buckets: ReadonlyMap<number, number>;
  /** Total observations (the `_count` series). */
  count: number;
  /** When this snapshot was taken (epoch ms). */
  takenAt: number;
}

/** A single cumulative counter reading. */
export interface CounterSnapshot {
  value: number;
  takenAt: number;
}

/**
 * Read a histogram's cumulative buckets, summed across every label combination.
 *
 * Summing across labels is deliberate: `imageProcessingDuration` is labelled by
 * `result`, and the operator's question is "how slow is image processing?", not
 * "how slow are the successes?". A timing out failure is precisely the slowness
 * worth paging on, so excluding it would hide the incident.
 */
export async function snapshotHistogram(
  histogram: Histogram<string>,
  now = Date.now(),
): Promise<HistogramSnapshot> {
  const metric = await histogram.get();
  const buckets = new Map<number, number>();
  let count = 0;

  for (const entry of metric.values) {
    // prom-client emits three series per histogram: `_bucket` (with an `le`
    // label), `_sum` and `_count`. Only the first two are needed here.
    const le = entry.labels?.le;
    if (le !== undefined) {
      const bound = Number(le);
      // `le="+Inf"` arrives as the string '+Inf' → NaN. It carries no bound
      // information beyond `_count`, which is read separately below.
      if (Number.isFinite(bound)) {
        buckets.set(bound, (buckets.get(bound) ?? 0) + entry.value);
      }
      continue;
    }
    if (entry.metricName?.endsWith('_count')) {
      count += entry.value;
    }
  }

  return { buckets, count, takenAt: now };
}

/** Read a counter's cumulative value, summed across every label combination. */
export async function snapshotCounter(
  counter: Counter<string>,
  now = Date.now(),
): Promise<CounterSnapshot> {
  const metric = await counter.get();
  const value = metric.values.reduce((sum, entry) => sum + entry.value, 0);
  return { value, takenAt: now };
}

/**
 * Read a counter's cumulative value per label, e.g. per SMS provider.
 *
 * Returns a map from the label value to its total, so a rule can alert on the
 * provider that is actually failing rather than on an aggregate that hides
 * which one broke.
 */
export async function snapshotCounterBy(
  counter: Counter<string>,
  labelName: string,
  now = Date.now(),
): Promise<ReadonlyMap<string, CounterSnapshot>> {
  const metric = await counter.get();
  const totals = new Map<string, number>();

  for (const entry of metric.values) {
    const label = String(entry.labels?.[labelName] ?? 'unknown');
    totals.set(label, (totals.get(label) ?? 0) + entry.value);
  }

  return new Map(
    [...totals].map(([label, value]) => [label, { value, takenAt: now }]),
  );
}

/**
 * Increase of a counter between two snapshots — `increase(counter[window])`.
 * A negative result means the process restarted; the current value is then the
 * whole increase we can account for.
 */
export function counterIncrease(
  previous: CounterSnapshot | undefined,
  current: CounterSnapshot,
): number {
  if (previous === undefined) return 0;
  const delta = current.value - previous.value;
  return delta >= 0 ? delta : current.value;
}

/**
 * Per-bucket increase between two histogram snapshots, i.e. the histogram of
 * observations that happened WITHIN the window.
 */
export function histogramIncrease(
  previous: HistogramSnapshot | undefined,
  current: HistogramSnapshot,
): { buckets: Map<number, number>; count: number } {
  const buckets = new Map<number, number>();

  for (const [bound, value] of current.buckets) {
    const before = previous?.buckets.get(bound);
    const delta = before === undefined ? value : value - before;
    // A negative per-bucket delta is a restart; fall back to the current value.
    buckets.set(bound, delta >= 0 ? delta : value);
  }

  const countDelta =
    previous === undefined ? current.count : current.count - previous.count;

  return {
    buckets,
    count: countDelta >= 0 ? countDelta : current.count,
  };
}

/**
 * Estimate a quantile from CUMULATIVE histogram buckets by linear interpolation
 * within the matching bucket — the same algorithm as PromQL's
 * `histogram_quantile`, and subject to the same accuracy limit: the result is
 * only as precise as the bucket boundaries allow.
 *
 * Returns `undefined` when there are no observations, or when the quantile
 * falls in the open-ended `+Inf` bucket — in that case every finite bound has
 * been exceeded and the true value is unbounded above, so reporting the largest
 * bound would UNDERSTATE the latency at exactly the moment it matters most.
 *
 * @param buckets cumulative counts keyed by upper bound (seconds)
 * @param count   total observations, including those above the largest bound
 * @param q       quantile in (0, 1), e.g. 0.95
 */
export function quantileFromBuckets(
  buckets: ReadonlyMap<number, number>,
  count: number,
  q: number,
): number | undefined {
  if (count <= 0 || buckets.size === 0) return undefined;

  const sorted = [...buckets.entries()].sort(([a], [b]) => a - b);
  const rank = q * count;

  let previousBound = 0;
  let previousCount = 0;

  for (const [bound, cumulative] of sorted) {
    if (cumulative >= rank) {
      // The quantile lies inside (previousBound, bound]. Interpolate linearly,
      // assuming observations are spread evenly across the bucket.
      const inBucket = cumulative - previousCount;
      if (inBucket <= 0) return previousBound;
      const position = (rank - previousCount) / inBucket;
      return previousBound + (bound - previousBound) * position;
    }
    previousBound = bound;
    previousCount = cumulative;
  }

  // Past the largest finite bound → the quantile is in `+Inf`. Unbounded.
  return undefined;
}

/**
 * P95 over the observations that occurred between two snapshots.
 *
 * Returns the quantile together with the sample count, so a caller can refuse
 * to alert on a quantile computed from too few observations (see
 * ALERT_P95_MIN_SAMPLES).
 */
export function windowedQuantile(
  previous: HistogramSnapshot | undefined,
  current: HistogramSnapshot,
  q: number,
): { value: number | undefined; samples: number } {
  const { buckets, count } = histogramIncrease(previous, current);
  return { value: quantileFromBuckets(buckets, count, q), samples: count };
}
