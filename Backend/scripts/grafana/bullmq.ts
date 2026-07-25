import {
  INST,
  Layout,
  RI,
  dashboard,
  datasourceVar,
  queryVar,
  resetPanelIds,
  row,
  stat,
  table,
  timeseries,
} from './lib';
import { dashboardLinks } from './backend-overview';

/**
 * BullMQ — queue depth, throughput, latency and worker liveness.
 *
 * Every panel is driven by the `$queue` variable, populated from
 * `label_values(mator_bullmq_jobs, queue)`. Nothing here hard-codes a queue
 * name, so the four current queues (image-processing, sms, notifications,
 * maintenance) and any queue added later appear automatically — which is the
 * "support all existing queues" requirement.
 *
 * ── The aggregation trap this dashboard avoids ──
 * `mator_bullmq_jobs` is a GAUGE sampled per scraping process. Under PM2 cluster
 * mode every backend instance reports the SAME queue depth (they all read one
 * Redis), so `sum()` would multiply the depth by the instance count and invent a
 * backlog that does not exist. Every depth panel therefore uses `max by (queue)`,
 * which is correct for both single and multi-instance deployments.
 */
export function buildBullmq(): unknown {
  resetPanelIds();
  const l = new Layout();
  const panels: unknown[] = [];

  const QSEL = `{${INST}, queue=~"$queue"}`;

  // ── Summary ───────────────────────────────────────────────────────────────
  panels.push(row('Queue Summary', l));

  const summary: [string, string, string, string, { color: string; value: number | null }[] | undefined][] =
    [
      ['Waiting', 'waiting', 'Jobs queued and not yet picked up.', 'blue', undefined],
      ['Active', 'active', 'Jobs currently being processed by a worker.', 'green', undefined],
      ['Delayed', 'delayed', 'Jobs scheduled to run later (retry backoff or repeatable).', 'purple', undefined],
      [
        'Failed',
        'failed',
        'Jobs in the failed set (bounded by the retention policy).',
        'red',
        [
          { color: 'green', value: null },
          { color: 'yellow', value: 1 },
          { color: 'red', value: 25 },
        ],
      ],
    ];

  for (const [title, state, description, color, thresholds] of summary) {
    panels.push(
      stat(
        {
          title: `${title} Jobs`,
          description,
          unit: 'short',
          decimals: 0,
          width: 4,
          colorMode: thresholds ? 'background' : 'value',
          thresholds: thresholds ?? [{ color, value: null }],
          targets: [
            {
              // max, not sum — see the class docblock on multi-instance scraping.
              expr: `sum(max by (queue) (mator_bullmq_jobs{${INST}, queue=~"$queue", state="${state}"}))`,
              legendFormat: title.toLowerCase(),
            },
          ],
        },
        l,
      ),
    );
  }

  panels.push(
    stat(
      {
        title: 'Workers',
        description:
          'Workers attached across the selected queues. Zero while jobs are waiting means nothing is consuming them.',
        unit: 'short',
        decimals: 0,
        width: 4,
        colorMode: 'background',
        thresholds: [
          { color: 'red', value: null },
          { color: 'green', value: 1 },
        ],
        targets: [
          {
            expr: `sum(max by (queue) (mator_bullmq_workers${QSEL}))`,
            legendFormat: 'workers',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Jobs/sec',
        description: 'Terminal job completions per second (success + failure).',
        unit: 'ops',
        decimals: 2,
        width: 4,
        targets: [
          {
            expr: `sum(rate(mator_bullmq_jobs_processed_total${QSEL}[${RI}]))`,
            legendFormat: 'jobs/s',
          },
        ],
      },
      l,
    ),
  );

  // ── Depth over time ───────────────────────────────────────────────────────
  panels.push(row('Queue Depth', l));

  panels.push(
    timeseries(
      {
        title: 'Waiting Jobs by Queue',
        description:
          'Backlog per queue. A line that climbs and does not drain is the signal to check worker count.',
        unit: 'short',
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr: `max by (queue) (mator_bullmq_jobs{${INST}, queue=~"$queue", state="waiting"})`,
            legendFormat: '{{queue}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Active Jobs by Queue',
        description: 'In-flight jobs per queue — bounded by each worker\'s concurrency setting.',
        unit: 'short',
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr: `max by (queue) (mator_bullmq_jobs{${INST}, queue=~"$queue", state="active"})`,
            legendFormat: '{{queue}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Delayed Jobs by Queue',
        description:
          'Jobs waiting on a schedule or a retry backoff. A spike here usually follows a burst of failures.',
        unit: 'short',
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max'],
        targets: [
          {
            expr: `max by (queue) (mator_bullmq_jobs{${INST}, queue=~"$queue", state="delayed"})`,
            legendFormat: '{{queue}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Failed & Completed Sets by Queue',
        description:
          'Sizes of BullMQ\'s retained failed/completed sets. These are bounded by removeOnComplete/removeOnFail, so they plateau by design — use the rate panels below for true throughput.',
        unit: 'short',
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['lastNotNull'],
        targets: [
          {
            expr: `max by (queue) (mator_bullmq_jobs{${INST}, queue=~"$queue", state="failed"})`,
            legendFormat: '{{queue}} failed',
          },
          {
            expr: `max by (queue) (mator_bullmq_jobs{${INST}, queue=~"$queue", state="completed"})`,
            legendFormat: '{{queue}} completed',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byRegexp', options: '/.*failed/' },
            properties: [{ id: 'color', value: { fixedColor: 'red', mode: 'fixed' } }],
          },
        ],
      },
      l,
    ),
  );

  // ── Throughput ────────────────────────────────────────────────────────────
  panels.push(row('Throughput & Outcomes', l));

  panels.push(
    timeseries(
      {
        title: 'Jobs Processed/sec by Queue',
        description: 'Terminal outcomes per second, split by queue.',
        unit: 'ops',
        decimals: 3,
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max'],
        targets: [
          {
            expr: `sum by (queue) (rate(mator_bullmq_jobs_processed_total${QSEL}[${RI}]))`,
            legendFormat: '{{queue}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Success vs Failure Rate',
        description: 'Job outcomes per second across the selected queues.',
        unit: 'ops',
        decimals: 3,
        min: 0,
        width: 12,
        stacking: true,
        fillOpacity: 40,
        targets: [
          {
            expr: `sum by (result) (rate(mator_bullmq_jobs_processed_total${QSEL}[${RI}]))`,
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
        title: 'Failure Rate % by Queue',
        description:
          'Share of terminal jobs that failed. Counted once per job after retries are exhausted, so a flaky job that eventually succeeds does not appear here.',
        unit: 'percent',
        decimals: 2,
        min: 0,
        max: 100,
        width: 24,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 5 },
          { color: 'red', value: 20 },
        ],
        targets: [
          {
            expr:
              `100 * (sum by (queue) (rate(mator_bullmq_jobs_processed_total{${INST}, queue=~"$queue", result="failure"}[${RI}])) or vector(0))\n` +
              `  / clamp_min(sum by (queue) (rate(mator_bullmq_jobs_processed_total${QSEL}[${RI}])), 1e-9)`,
            legendFormat: '{{queue}}',
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
        title: 'Processing Duration P95 by Queue',
        description:
          'Worker processing time only (BullMQ processedOn → finishedOn); queue waiting time is excluded. NOTE: buckets top out at 120s — for the image pipeline use the Image Processing dashboard.',
        unit: 's',
        decimals: 3,
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max'],
        targets: [
          {
            expr: `histogram_quantile(0.95, sum by (le, queue) (rate(mator_bullmq_job_duration_seconds_bucket${QSEL}[${RI}])))`,
            legendFormat: '{{queue}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Average Processing Duration by Queue',
        description: 'sum/count — the mean time a worker spends on one job.',
        unit: 's',
        decimals: 3,
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max'],
        targets: [
          {
            expr:
              `sum by (queue) (rate(mator_bullmq_job_duration_seconds_sum${QSEL}[${RI}]))\n` +
              `  / clamp_min(sum by (queue) (rate(mator_bullmq_job_duration_seconds_count${QSEL}[${RI}])), 1e-9)`,
            legendFormat: '{{queue}}',
          },
        ],
      },
      l,
    ),
  );

  // ── Workers ───────────────────────────────────────────────────────────────
  panels.push(row('Workers', l));

  panels.push(
    timeseries(
      {
        title: 'Worker Count by Queue',
        description:
          'Workers attached per queue. A drop to zero while waiting > 0 is the "workers stopped" condition — it never self-heals.',
        unit: 'short',
        min: 0,
        width: 12,
        drawStyle: 'line',
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['min', 'lastNotNull'],
        targets: [
          {
            expr: `max by (queue) (mator_bullmq_workers${QSEL})`,
            legendFormat: '{{queue}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    table(
      {
        title: 'Queue State Breakdown',
        description:
          'Current depth of every queue in every state — the at-a-glance table for triage.',
        unit: 'short',
        decimals: 0,
        width: 12,
        targets: [
          {
            expr: `max by (queue, state) (mator_bullmq_jobs${QSEL})`,
            legendFormat: '{{queue}} {{state}}',
            instant: true,
            format: 'table',
          },
        ],
        transformations: [
          { id: 'organize', options: { excludeByName: { Time: true, __name__: true, instance: true, job: true } } },
        ],
      },
      l,
    ),
  );

  return dashboard({
    uid: 'mator-bullmq',
    title: 'Mator — BullMQ Queues',
    description:
      'Queue depth, throughput, processing duration and worker liveness for every BullMQ queue. Queues are discovered automatically.',
    tags: ['mator', 'bullmq', 'queues'],
    refresh: '30s',
    from: 'now-6h',
    panels,
    templating: [
      datasourceVar(),
      queryVar({
        name: 'instance',
        label: 'Instance',
        metric: 'mator_bullmq_jobs',
        labelName: 'instance',
      }),
      queryVar({
        name: 'queue',
        label: 'Queue',
        metric: 'mator_bullmq_jobs',
        labelName: 'queue',
        description:
          'Populated from the metrics themselves, so newly registered queues appear with no dashboard edit.',
      }),
    ],
    links: dashboardLinks(),
  });
}
