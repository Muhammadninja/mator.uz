import {
  counterIncrease,
  histogramIncrease,
  quantileFromBuckets,
  windowedQuantile,
  type CounterSnapshot,
  type HistogramSnapshot,
} from './metric-window';
import { SnapshotWindow } from './snapshot-window';

/**
 * The windowing arithmetic is the part of this module most likely to be silently
 * wrong — a P95 that is subtly off still looks like a number, and a counter
 * delta that mishandles a restart produces a negative "rate" nobody notices
 * until an alert fails to fire. These tests pin the semantics.
 */

function histogram(
  buckets: Record<number, number>,
  count: number,
  takenAt = 0,
): HistogramSnapshot {
  return {
    buckets: new Map(
      Object.entries(buckets).map(([bound, value]) => [Number(bound), value]),
    ),
    count,
    takenAt,
  };
}

describe('quantileFromBuckets', () => {
  it('interpolates within the bucket the quantile falls in', () => {
    // 100 observations, cumulative: 50 ≤1s, 100 ≤2s. P95 → rank 95, which sits
    // in the (1, 2] bucket at (95-50)/50 = 90% of the way through it.
    const buckets = new Map([
      [1, 50],
      [2, 100],
    ]);

    expect(quantileFromBuckets(buckets, 100, 0.95)).toBeCloseTo(1.9, 5);
  });

  it('returns the lower bound when the quantile lands on a boundary', () => {
    const buckets = new Map([
      [1, 95],
      [2, 100],
    ]);

    expect(quantileFromBuckets(buckets, 100, 0.95)).toBeCloseTo(1, 5);
  });

  it('returns undefined when the quantile is in the +Inf bucket', () => {
    // 100 observations but only 80 fall at/below the largest finite bound, so
    // the P95 is genuinely unbounded — reporting 2 would UNDERSTATE it.
    const buckets = new Map([
      [1, 50],
      [2, 80],
    ]);

    expect(quantileFromBuckets(buckets, 100, 0.95)).toBeUndefined();
  });

  it('returns undefined with no observations', () => {
    expect(quantileFromBuckets(new Map([[1, 0]]), 0, 0.95)).toBeUndefined();
    expect(quantileFromBuckets(new Map(), 10, 0.95)).toBeUndefined();
  });
});

describe('counterIncrease', () => {
  const at = (value: number, takenAt = 0): CounterSnapshot => ({
    value,
    takenAt,
  });

  it('is the difference between two readings', () => {
    expect(counterIncrease(at(10), at(27))).toBe(17);
  });

  it('is zero without a baseline — cumulative history is not "this window"', () => {
    expect(counterIncrease(undefined, at(500))).toBe(0);
  });

  it('treats a decrease as a process restart and uses the current value', () => {
    // Counter reset to 0 on restart, then climbed to 3. The increase we can
    // account for is 3 — never the negative -497.
    expect(counterIncrease(at(500), at(3))).toBe(3);
  });
});

describe('histogramIncrease', () => {
  it('differences each bucket and the total count', () => {
    const previous = histogram({ 1: 10, 2: 20 }, 25);
    const current = histogram({ 1: 12, 2: 30 }, 40);

    const result = histogramIncrease(previous, current);

    expect(result.buckets.get(1)).toBe(2);
    expect(result.buckets.get(2)).toBe(10);
    expect(result.count).toBe(15);
  });

  it('falls back to current values when a restart shrinks a bucket', () => {
    const previous = histogram({ 1: 100 }, 100);
    const current = histogram({ 1: 4 }, 4);

    const result = histogramIncrease(previous, current);

    expect(result.buckets.get(1)).toBe(4);
    expect(result.count).toBe(4);
  });
});

describe('windowedQuantile', () => {
  it('computes the quantile over the window, ignoring prior history', () => {
    // 1000 fast observations before the window; inside it, 100 slow ones.
    // A cumulative read would be dominated by the fast history and report a
    // healthy P95 — the exact failure this windowing exists to prevent.
    const previous = histogram({ 1: 1000, 60: 1000 }, 1000);
    const current = histogram({ 1: 1000, 60: 1100 }, 1100);

    const { value, samples } = windowedQuantile(previous, current, 0.95);

    expect(samples).toBe(100);
    // All 100 in-window observations are in the (1, 60] bucket → P95 is high.
    expect(value).toBeGreaterThan(45);
  });

  it('reports the sample count so a caller can reject a thin window', () => {
    const previous = histogram({ 1: 10 }, 10);
    const current = histogram({ 1: 12 }, 12);

    expect(windowedQuantile(previous, current, 0.95).samples).toBe(2);
  });
});

describe('SnapshotWindow', () => {
  const MINUTE = 60_000;

  it('returns no baseline on the first push', () => {
    const window = new SnapshotWindow<CounterSnapshot>(5 * MINUTE);

    expect(window.push({ value: 1, takenAt: 0 })).toBeUndefined();
  });

  it('diffs against the oldest snapshot still inside the window', () => {
    // 60s ticks, 5min window. At t=5min the baseline must be t=0 — measuring
    // the full window, NOT the previous 60s tick.
    const window = new SnapshotWindow<CounterSnapshot>(5 * MINUTE);
    for (let minute = 0; minute <= 4; minute++) {
      window.push({ value: minute, takenAt: minute * MINUTE });
    }

    const baseline = window.push({ value: 5, takenAt: 5 * MINUTE });

    expect(baseline?.takenAt).toBe(0);
  });

  it('slides the lower edge forward as snapshots age out', () => {
    const window = new SnapshotWindow<CounterSnapshot>(5 * MINUTE);
    for (let minute = 0; minute <= 5; minute++) {
      window.push({ value: minute, takenAt: minute * MINUTE });
    }

    // At t=6min the t=0 snapshot has fallen out; t=1min is the new lower edge.
    const baseline = window.push({ value: 6, takenAt: 6 * MINUTE });

    expect(baseline?.takenAt).toBe(1 * MINUTE);
  });

  it('stays bounded when snapshots never age out', () => {
    const window = new SnapshotWindow<CounterSnapshot>(
      Number.MAX_SAFE_INTEGER,
      4,
    );

    for (let i = 0; i < 50; i++) window.push({ value: i, takenAt: i });

    expect(window.size).toBeLessThanOrEqual(4);
  });
});
