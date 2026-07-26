/**
 * A bounded history of metric snapshots, used to evaluate a rule over a
 * configured rolling window rather than over one evaluation interval.
 *
 * ── Why this exists ──
 * The naive approach — keep only the previous snapshot and diff against it —
 * measures the EVALUATION INTERVAL (60s), not the configured window (5 min).
 * Those are different questions: "10 SMS failures in the last minute" and "10
 * in the last five" have very different thresholds, and silently evaluating the
 * former while the config says the latter is the kind of mismatch that makes an
 * alert threshold impossible to reason about.
 *
 * So this keeps every snapshot taken inside the window and diffs the current
 * reading against the OLDEST one still in it. With a 60s interval and a 5 min
 * window that is a 5-element ring — the memory cost of correct semantics.
 *
 * The window is a sliding lower bound, so the measured span is between
 * `window` and `window + interval`. That imprecision is inherent to sampling at
 * a fixed cadence (Prometheus's own `rate()` has it too) and is why thresholds
 * are set with headroom rather than at a knife's edge.
 */

/** Any snapshot carrying the time it was taken. */
export interface TimedSnapshot {
  takenAt: number;
}

export class SnapshotWindow<T extends TimedSnapshot> {
  private readonly snapshots: T[] = [];

  /**
   * @param windowMs how far back the window extends
   * @param maxRetained hard cap on retained snapshots, so a misconfigured
   *   window (or a stalled evaluator) can never grow this without bound
   */
  constructor(
    private readonly windowMs: number,
    private readonly maxRetained = DEFAULT_MAX_RETAINED,
  ) {}

  /**
   * Record `current` and return the oldest snapshot still inside the window —
   * the baseline to diff against, or `undefined` when the window has not yet
   * been filled enough to contain one.
   */
  push(current: T): T | undefined {
    const cutoff = current.takenAt - this.windowMs;

    // Drop everything that has fallen out of the window, but always keep the
    // most recent expired one as the baseline: with a 5 min window and 1 min
    // ticks, the snapshot from exactly 5 min ago is the correct lower edge, and
    // dropping it eagerly would shrink the measured span to 4 min.
    while (this.snapshots.length > 1 && this.snapshots[1].takenAt <= cutoff) {
      this.snapshots.shift();
    }

    // Cap retention regardless of timing, so a stalled clock cannot leak memory.
    while (this.snapshots.length >= this.maxRetained) {
      this.snapshots.shift();
    }

    const baseline = this.snapshots[0];
    this.snapshots.push(current);
    return baseline;
  }

  /** Number of retained snapshots. Exposed for tests and diagnostics. */
  get size(): number {
    return this.snapshots.length;
  }

  /** Forget all history — used when a rule's config changes or in tests. */
  clear(): void {
    this.snapshots.length = 0;
  }
}

/**
 * Retention cap. Generous enough for a long window at a fast interval (e.g. a
 * 60 min window at 60s ticks) while keeping the structure trivially bounded.
 */
const DEFAULT_MAX_RETAINED = 128;
