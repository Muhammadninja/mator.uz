import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../metrics/metrics.service';
import { resolveAlertingConfig, type AlertingConfig } from '../alerting.config';
import {
  AlertSeverity,
  NO_ALERTS,
  type AlertRule,
  type RuleResult,
} from '../alerting.types';
import {
  snapshotHistogram,
  windowedQuantile,
  type HistogramSnapshot,
} from '../metric-window';
import { SnapshotWindow } from '../snapshot-window';

/**
 * Alerts when the P95 of `image_processing_duration_seconds` over the rolling
 * window exceeds IMAGE_PROCESSING_P95_THRESHOLD.
 *
 * ── Why a window and not the raw histogram ──
 * prom-client histograms are cumulative since process start, so a raw P95 both
 * fails to recover after a bad period and hides a fresh incident under a long
 * healthy history. This rule keeps the previous bucket snapshot and computes
 * the quantile over the DELTA — the in-process equivalent of PromQL's
 * `histogram_quantile(0.95, rate(..._bucket[5m]))`. See metric-window.ts.
 *
 * It reuses the histogram the image worker ALREADY populates rather than adding
 * a second timer, so there is exactly one source of truth for image latency and
 * the alert can never disagree with the Grafana panel beside it.
 *
 * ── First evaluation ──
 * With no previous snapshot there is no window, so nothing fires: a rule must
 * never alert on data it cannot yet interpret. The first tick establishes the
 * baseline; the second is the first that can alert.
 */

/** The quantile this rule evaluates. */
const P95 = 0.95;

/** Decimal places when rendering seconds in the message. */
const SECONDS_PRECISION = 1;

@Injectable()
export class ImageLatencyRule implements AlertRule {
  readonly name = 'image_processing_latency';

  private readonly logger = new Logger(ImageLatencyRule.name);
  private readonly config: AlertingConfig;
  /**
   * Snapshots spanning the configured window. Diffing against the OLDEST one
   * still inside it is what makes this a true `[5m]` window rather than a
   * measurement of the 60s evaluation interval — see snapshot-window.ts.
   */
  private readonly window: SnapshotWindow<HistogramSnapshot>;

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.config = resolveAlertingConfig(config);
    this.window = new SnapshotWindow(this.config.rateWindowMin * 60 * 1000);
  }

  async evaluate(): Promise<RuleResult> {
    const current = await snapshotHistogram(
      this.metrics.imageProcessingDurationMetric,
    );
    const previous = this.window.push(current);

    // First tick: baseline only, nothing to compare against yet.
    if (previous === undefined) return NO_ALERTS;

    const { value: p95, samples } = windowedQuantile(previous, current, P95);

    // Too few images processed in the window for a quantile to mean anything —
    // a P95 over two observations is noise, not a signal.
    if (samples < this.config.p95MinSamples) return NO_ALERTS;

    // `undefined` means the quantile fell in the open-ended `+Inf` bucket: every
    // finite bound (up to 300s) was exceeded. That is unambiguously worse than
    // the threshold, so it alerts — reported as "> largest bucket" rather than a
    // fabricated number.
    const exceeded =
      p95 === undefined || p95 > this.config.imageP95ThresholdSec;
    if (!exceeded) return NO_ALERTS;

    const rendered =
      p95 === undefined
        ? `> ${MAX_REPORTABLE_LABEL}`
        : `${p95.toFixed(SECONDS_PRECISION)} sec`;

    this.logger.debug(
      `Image P95 ${rendered} over ${samples} samples (threshold ${this.config.imageP95ThresholdSec}s)`,
    );

    return {
      firing: [
        {
          rule: this.name,
          // WARNING, not ERROR: slow image processing degrades the seller's
          // experience but nothing is lost — jobs still complete. An unbounded
          // P95 (past the largest bucket) means the pipeline is effectively
          // stalled, which is a different situation.
          severity:
            p95 === undefined ? AlertSeverity.ERROR : AlertSeverity.WARNING,
          labels: { pipeline: 'image_processing' },
          values: {
            p95: rendered,
            threshold: `${this.config.imageP95ThresholdSec} sec`,
            samples,
            window: `${this.config.rateWindowMin} min`,
          },
          title: 'Image Processing',
          summary: 'image processing latency',
        },
      ],
    };
  }
}

/**
 * Shown when the P95 exceeds the histogram's largest finite bucket. Kept as a
 * label rather than a number because the true value is genuinely unbounded
 * above — reporting the bucket bound would understate the incident.
 */
const MAX_REPORTABLE_LABEL = 'largest bucket';
