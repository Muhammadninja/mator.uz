import {
  INST,
  Layout,
  RI,
  dashboard,
  datasourceVar,
  gauge,
  queryVar,
  resetPanelIds,
  row,
  stat,
  timeseries,
} from './lib';
import { dashboardLinks } from './backend-overview';

/**
 * Image Processing — the seller-facing pipeline: ingest the original from
 * Telegram, upload it to Cloudinary, run FLUX background removal, upload the
 * result.
 *
 * Uses `mator_image_processing_duration_seconds`, whose buckets run out to 300s
 * specifically because FLUX plus two Cloudinary round trips routinely take tens
 * of seconds. The generic BullMQ duration histogram tops out at 120s, so for
 * this pipeline THIS dashboard is the authoritative latency view.
 *
 * The `result` label has exactly two values (success / failure), which is what
 * makes the success/failure-rate maths here simple and exact.
 */
export function buildImageProcessing(): unknown {
  resetPanelIds();
  const l = new Layout();
  const panels: unknown[] = [];

  const SEL = `{${INST}}`;
  const OK = `{${INST}, result="success"}`;
  const BAD = `{${INST}, result="failure"}`;

  // ── Summary ───────────────────────────────────────────────────────────────
  panels.push(row('Summary', l));

  panels.push(
    gauge(
      {
        title: 'Success Rate',
        description:
          'Share of image jobs that completed successfully in the selected range. Counted per JOB after retries, not per attempt.',
        unit: 'percent',
        decimals: 2,
        width: 5,
        height: 5,
        thresholds: [
          { color: 'red', value: null },
          { color: 'yellow', value: 90 },
          { color: 'green', value: 98 },
        ],
        noValue: '—',
        targets: [
          {
            expr:
              `100 * (sum(increase(mator_image_processing_total${OK}[$__range])) or vector(0))\n` +
              `  / clamp_min(sum(increase(mator_image_processing_total${SEL}[$__range])), 1e-9)`,
            legendFormat: 'success %',
            instant: true,
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Failure Rate',
        description: 'Share of image jobs that failed permanently in the selected range.',
        unit: 'percent',
        decimals: 2,
        width: 5,
        height: 5,
        colorMode: 'background',
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 2 },
          { color: 'red', value: 10 },
        ],
        targets: [
          {
            expr:
              `100 * (sum(increase(mator_image_processing_total${BAD}[$__range])) or vector(0))\n` +
              `  / clamp_min(sum(increase(mator_image_processing_total${SEL}[$__range])), 1e-9)`,
            legendFormat: 'failure %',
            instant: true,
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Successful Jobs',
        description: 'Images processed successfully in the selected time range.',
        unit: 'short',
        decimals: 0,
        width: 3,
        height: 5,
        thresholds: [{ color: 'green', value: null }],
        targets: [
          {
            expr: `sum(increase(mator_image_processing_total${OK}[$__range]))`,
            legendFormat: 'success',
            instant: true,
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Failed Jobs',
        description: 'Images that failed permanently (all retries exhausted) in the range.',
        unit: 'short',
        decimals: 0,
        width: 3,
        height: 5,
        colorMode: 'background',
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 1 },
          { color: 'red', value: 10 },
        ],
        targets: [
          {
            expr: `sum(increase(mator_image_processing_total${BAD}[$__range]))`,
            legendFormat: 'failed',
            instant: true,
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Avg Duration',
        description: 'Mean end-to-end processing time (sum/count).',
        unit: 's',
        decimals: 1,
        width: 4,
        height: 5,
        targets: [
          {
            expr:
              `sum(rate(mator_image_processing_duration_seconds_sum${SEL}[${RI}]))\n` +
              `  / clamp_min(sum(rate(mator_image_processing_duration_seconds_count${SEL}[${RI}])), 1e-9)`,
            legendFormat: 'avg',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'P95 Duration',
        description:
          '95th percentile end-to-end processing time. Buckets extend to 300s so a slow FLUX run stays measurable.',
        unit: 's',
        decimals: 1,
        width: 4,
        height: 5,
        colorMode: 'background',
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 45 },
          { color: 'red', value: 120 },
        ],
        targets: [
          {
            expr: `histogram_quantile(0.95, sum by (le) (rate(mator_image_processing_duration_seconds_bucket${SEL}[${RI}])))`,
            legendFormat: 'p95',
          },
        ],
      },
      l,
    ),
  );

  // ── Duration ──────────────────────────────────────────────────────────────
  panels.push(row('Processing Duration', l));

  panels.push(
    timeseries(
      {
        title: 'Duration Percentiles',
        description:
          'P50/P95/P99 plus the average. FLUX degradation typically shows as p95 climbing well before the average moves.',
        unit: 's',
        decimals: 2,
        min: 0,
        width: 16,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr: `histogram_quantile(0.50, sum by (le) (rate(mator_image_processing_duration_seconds_bucket${SEL}[${RI}])))`,
            legendFormat: 'p50',
          },
          {
            expr: `histogram_quantile(0.95, sum by (le) (rate(mator_image_processing_duration_seconds_bucket${SEL}[${RI}])))`,
            legendFormat: 'p95',
          },
          {
            expr: `histogram_quantile(0.99, sum by (le) (rate(mator_image_processing_duration_seconds_bucket${SEL}[${RI}])))`,
            legendFormat: 'p99',
          },
          {
            expr:
              `sum(rate(mator_image_processing_duration_seconds_sum${SEL}[${RI}]))\n` +
              `  / clamp_min(sum(rate(mator_image_processing_duration_seconds_count${SEL}[${RI}])), 1e-9)`,
            legendFormat: 'average',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: 'average' },
            properties: [
              { id: 'color', value: { fixedColor: 'text', mode: 'fixed' } },
              { id: 'custom.lineStyle', value: { dash: [10, 10], fill: 'dash' } },
            ],
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Duration by Outcome (P95)',
        description:
          'Successes vs failures. Failures clustering near a fixed value usually means a timeout rather than genuine slowness.',
        unit: 's',
        decimals: 2,
        min: 0,
        width: 8,
        targets: [
          {
            expr: `histogram_quantile(0.95, sum by (le, result) (rate(mator_image_processing_duration_seconds_bucket${SEL}[${RI}])))`,
            legendFormat: '{{result}}',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: 'success' },
            properties: [{ id: 'color', value: { fixedColor: 'green', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: 'failure' },
            properties: [{ id: 'color', value: { fixedColor: 'red', mode: 'fixed' } }],
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Duration Distribution (bucket share)',
        description:
          'Share of jobs completing within each bucket boundary — a cumulative view of where the pipeline actually lands.',
        unit: 'percentunit',
        min: 0,
        max: 1,
        width: 24,
        fillOpacity: 0,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['lastNotNull'],
        targets: [
          {
            expr:
              `sum by (le) (rate(mator_image_processing_duration_seconds_bucket${SEL}[${RI}]))\n` +
              `  / clamp_min(scalar(sum(rate(mator_image_processing_duration_seconds_count${SEL}[${RI}]))), 1e-9)`,
            legendFormat: '≤ {{le}}s',
          },
        ],
      },
      l,
    ),
  );

  // ── Throughput ────────────────────────────────────────────────────────────
  panels.push(row('Throughput', l));

  panels.push(
    timeseries(
      {
        title: 'Processing Throughput',
        description: 'Images processed per minute, split by outcome.',
        unit: 'short',
        decimals: 2,
        min: 0,
        width: 12,
        stacking: true,
        fillOpacity: 40,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max'],
        targets: [
          {
            expr: `60 * sum by (result) (rate(mator_image_processing_total${SEL}[${RI}]))`,
            legendFormat: '{{result}}/min',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: 'success/min' },
            properties: [{ id: 'color', value: { fixedColor: 'green', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: 'failure/min' },
            properties: [{ id: 'color', value: { fixedColor: 'red', mode: 'fixed' } }],
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Success vs Failure Rate %',
        description: 'Outcome shares over time. The two lines always sum to 100%.',
        unit: 'percent',
        decimals: 2,
        min: 0,
        max: 100,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'lastNotNull'],
        targets: [
          {
            expr:
              `100 * (sum(rate(mator_image_processing_total${OK}[${RI}])) or vector(0))\n` +
              `  / clamp_min(sum(rate(mator_image_processing_total${SEL}[${RI}])), 1e-9)`,
            legendFormat: 'success %',
          },
          {
            expr:
              `100 * (sum(rate(mator_image_processing_total${BAD}[${RI}])) or vector(0))\n` +
              `  / clamp_min(sum(rate(mator_image_processing_total${SEL}[${RI}])), 1e-9)`,
            legendFormat: 'failure %',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: 'success %' },
            properties: [{ id: 'color', value: { fixedColor: 'green', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: 'failure %' },
            properties: [{ id: 'color', value: { fixedColor: 'red', mode: 'fixed' } }],
          },
        ],
      },
      l,
    ),
  );

  // ── Queue context ─────────────────────────────────────────────────────────
  panels.push(row('Queue Context', l));

  panels.push(
    timeseries(
      {
        title: 'Image Queue Depth',
        description:
          'The image-processing queue behind this pipeline. Waiting climbing while duration is flat means not enough worker concurrency, not a slow FLUX.',
        unit: 'short',
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr: `max by (state) (mator_bullmq_jobs{${INST}, queue="image-processing", state=~"waiting|active|delayed"})`,
            legendFormat: '{{state}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Image Workers',
        description:
          'Workers attached to the image-processing queue. Concurrency is set by IMAGE_CONCURRENCY.',
        unit: 'short',
        min: 0,
        width: 12,
        targets: [
          {
            expr: `max(mator_bullmq_workers{${INST}, queue="image-processing"})`,
            legendFormat: 'workers',
          },
        ],
      },
      l,
    ),
  );

  return dashboard({
    uid: 'mator-image-processing',
    title: 'Mator — Image Processing',
    description:
      'FLUX/Cloudinary image pipeline: duration percentiles, throughput, success and failure rates.',
    tags: ['mator', 'images', 'pipeline'],
    refresh: '30s',
    from: 'now-12h',
    panels,
    templating: [
      datasourceVar(),
      queryVar({
        name: 'instance',
        label: 'Instance',
        metric: 'mator_image_processing_total',
        labelName: 'instance',
      }),
    ],
    links: dashboardLinks(),
  });
}
