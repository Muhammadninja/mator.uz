import {
  DS,
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

/**
 * Backend Overview — the "is the API healthy?" dashboard, and the one an
 * operator should open first during an incident.
 *
 * Layout follows the standard triage order: a top row of single-value health
 * indicators (answers "is something wrong?" in one glance), then traffic and
 * errors (answers "what kind of wrong?"), then latency, then process/runtime
 * health (answers "is it the app or the box?").
 */
export function buildBackendOverview(): unknown {
  resetPanelIds();
  const l = new Layout();
  const panels: unknown[] = [];

  // ── Health summary ────────────────────────────────────────────────────────
  panels.push(row('Health Summary', l));

  panels.push(
    stat(
      {
        title: 'Requests/sec',
        description: 'Current request throughput across all selected instances.',
        unit: 'reqps',
        decimals: 2,
        targets: [
          {
            expr: `sum(rate(mator_http_requests_total{${INST}}[${RI}]))`,
            legendFormat: 'req/s',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Total Requests',
        description:
          'Total requests served in the selected time range (increase() over the window, so it reflects the picker, not process lifetime).',
        unit: 'short',
        decimals: 0,
        targets: [
          {
            expr: `sum(increase(mator_http_requests_total{${INST}}[$__range]))`,
            legendFormat: 'total',
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
        title: 'Error Rate',
        description:
          'Share of responses with a 4xx or 5xx status. Green <1%, amber ≥1%, red ≥5%.',
        unit: 'percent',
        decimals: 2,
        colorMode: 'background',
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 1 },
          { color: 'red', value: 5 },
        ],
        targets: [
          {
            // `or vector(0)` keeps the panel at 0 rather than "No data" on a
            // quiet system where no error series exists yet.
            expr:
              `100 * (\n` +
              `  sum(rate(mator_http_requests_total{${INST}, status_code=~"4..|5.."}[${RI}]))\n` +
              `  or vector(0)\n` +
              `) / clamp_min(sum(rate(mator_http_requests_total{${INST}}[${RI}])), 1e-9)`,
            legendFormat: 'error %',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'P95 Latency',
        description: '95th percentile request duration across selected instances.',
        unit: 's',
        decimals: 3,
        colorMode: 'background',
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 0.5 },
          { color: 'red', value: 1 },
        ],
        targets: [
          {
            expr: `histogram_quantile(0.95, sum by (le) (rate(mator_http_request_duration_seconds_bucket{${INST}}[${RI}])))`,
            legendFormat: 'p95',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'In-Flight Requests',
        description: 'Requests currently being processed. A sustained climb means saturation.',
        unit: 'short',
        decimals: 0,
        targets: [
          {
            expr: `sum(mator_http_requests_in_flight{${INST}})`,
            legendFormat: 'in flight',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Uptime',
        description:
          'Time since process start (min across instances, so a single restart is visible).',
        unit: 's',
        decimals: 0,
        colorMode: 'value',
        graphMode: 'none',
        targets: [
          {
            expr: `min(time() - mator_process_start_time_seconds{${INST}})`,
            legendFormat: 'uptime',
          },
        ],
      },
      l,
    ),
  );

  // ── Traffic & errors ──────────────────────────────────────────────────────
  panels.push(row('Traffic & Errors', l));

  panels.push(
    timeseries(
      {
        title: 'Request Rate by Method',
        description: 'Throughput split by HTTP verb.',
        unit: 'reqps',
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr: `sum by (method) (rate(mator_http_requests_total{${INST}, method=~"$method"}[${RI}]))`,
            legendFormat: '{{method}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Request Rate by Status Code',
        description:
          'Throughput split by status. Stacked so total traffic and the error share read at once.',
        unit: 'reqps',
        width: 12,
        stacking: true,
        fillOpacity: 40,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        // Conventional status colours: 2xx green, 4xx amber, 5xx red.
        overrides: [
          {
            matcher: { id: 'byRegexp', options: '/^2../' },
            properties: [{ id: 'color', value: { fixedColor: 'green', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byRegexp', options: '/^3../' },
            properties: [{ id: 'color', value: { fixedColor: 'blue', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byRegexp', options: '/^4../' },
            properties: [{ id: 'color', value: { fixedColor: 'orange', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byRegexp', options: '/^5../' },
            properties: [{ id: 'color', value: { fixedColor: 'red', mode: 'fixed' } }],
          },
        ],
        targets: [
          {
            expr: `sum by (status_code) (rate(mator_http_requests_total{${INST}}[${RI}]))`,
            legendFormat: '{{status_code}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Error Rate % (4xx vs 5xx)',
        description:
          'Client vs server error share of total traffic. 5xx is ours; 4xx is usually the caller.',
        unit: 'percent',
        decimals: 2,
        min: 0,
        width: 12,
        targets: [
          {
            expr:
              `100 * (sum(rate(mator_http_requests_total{${INST}, status_code=~"4.."}[${RI}])) or vector(0))\n` +
              `  / clamp_min(sum(rate(mator_http_requests_total{${INST}}[${RI}])), 1e-9)`,
            legendFormat: '4xx %',
          },
          {
            expr:
              `100 * (sum(rate(mator_http_requests_total{${INST}, status_code=~"5.."}[${RI}])) or vector(0))\n` +
              `  / clamp_min(sum(rate(mator_http_requests_total{${INST}}[${RI}])), 1e-9)`,
            legendFormat: '5xx %',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: '4xx %' },
            properties: [{ id: 'color', value: { fixedColor: 'orange', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: '5xx %' },
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
        title: 'Top Routes by Request Rate',
        description:
          'Busiest endpoints. Route labels are Express templates (/products/:id), so ids never fragment the series.',
        unit: 'reqps',
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'lastNotNull'],
        targets: [
          {
            expr: `topk(10, sum by (route) (rate(mator_http_requests_total{${INST}, route=~"$route"}[${RI}])))`,
            legendFormat: '{{route}}',
          },
        ],
      },
      l,
    ),
  );

  // ── Latency ───────────────────────────────────────────────────────────────
  panels.push(row('Latency', l));

  panels.push(
    timeseries(
      {
        title: 'Latency Percentiles (P50 / P95 / P99)',
        description:
          'Percentiles interpolated from the histogram buckets. P99 rising while P50 is flat means a slow minority, not a global slowdown.',
        unit: 's',
        decimals: 3,
        min: 0,
        width: 16,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr: `histogram_quantile(0.50, sum by (le) (rate(mator_http_request_duration_seconds_bucket{${INST}}[${RI}])))`,
            legendFormat: 'p50',
          },
          {
            expr: `histogram_quantile(0.95, sum by (le) (rate(mator_http_request_duration_seconds_bucket{${INST}}[${RI}])))`,
            legendFormat: 'p95',
          },
          {
            expr: `histogram_quantile(0.99, sum by (le) (rate(mator_http_request_duration_seconds_bucket{${INST}}[${RI}])))`,
            legendFormat: 'p99',
          },
          {
            // Average = sum/count. Deliberately shown NEXT TO percentiles: on its
            // own an average hides the tail that users actually feel.
            expr:
              `sum(rate(mator_http_request_duration_seconds_sum{${INST}}[${RI}]))\n` +
              `  / clamp_min(sum(rate(mator_http_request_duration_seconds_count{${INST}}[${RI}])), 1e-9)`,
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
    stat(
      {
        title: 'P50',
        unit: 's',
        decimals: 3,
        width: 8,
        height: 4,
        targets: [
          {
            expr: `histogram_quantile(0.50, sum by (le) (rate(mator_http_request_duration_seconds_bucket{${INST}}[${RI}])))`,
            legendFormat: 'p50',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'P99',
        unit: 's',
        decimals: 3,
        width: 8,
        height: 4,
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 1 },
          { color: 'red', value: 2.5 },
        ],
        colorMode: 'background',
        targets: [
          {
            expr: `histogram_quantile(0.99, sum by (le) (rate(mator_http_request_duration_seconds_bucket{${INST}}[${RI}])))`,
            legendFormat: 'p99',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Slowest Routes (P95)',
        description: 'Per-route p95. The first place to look when overall p95 moves.',
        unit: 's',
        decimals: 3,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['max', 'lastNotNull'],
        targets: [
          {
            expr: `topk(10, histogram_quantile(0.95, sum by (le, route) (rate(mator_http_request_duration_seconds_bucket{${INST}, route=~"$route"}[${RI}]))))`,
            legendFormat: '{{route}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'In-Flight Requests',
        description:
          'Concurrency per instance. Should return to baseline; a ratchet upward indicates stuck requests.',
        unit: 'short',
        width: 12,
        targets: [
          {
            expr: `sum by (instance) (mator_http_requests_in_flight{${INST}})`,
            legendFormat: '{{instance}}',
          },
        ],
      },
      l,
    ),
  );

  // ── Runtime / process ─────────────────────────────────────────────────────
  panels.push(row('Process & Runtime', l));

  panels.push(
    timeseries(
      {
        title: 'CPU Usage',
        description:
          'Process CPU as a percentage of one core. 100% = one core saturated; Node is single-threaded for JS, so sustained ~100% means CPU-bound.',
        unit: 'percent',
        decimals: 1,
        min: 0,
        width: 8,
        targets: [
          {
            expr: `100 * sum by (instance) (rate(mator_process_cpu_seconds_total{${INST}}[${RI}]))`,
            legendFormat: '{{instance}} total',
          },
          {
            expr: `100 * sum by (instance) (rate(mator_process_cpu_user_seconds_total{${INST}}[${RI}]))`,
            legendFormat: '{{instance}} user',
          },
          {
            expr: `100 * sum by (instance) (rate(mator_process_cpu_system_seconds_total{${INST}}[${RI}]))`,
            legendFormat: '{{instance}} system',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Memory (RSS & External)',
        description: 'Resident set size — the number to watch for a container OOM kill.',
        unit: 'bytes',
        min: 0,
        width: 8,
        targets: [
          {
            expr: `sum by (instance) (mator_process_resident_memory_bytes{${INST}})`,
            legendFormat: '{{instance}} rss',
          },
          {
            expr: `sum by (instance) (mator_nodejs_external_memory_bytes{${INST}})`,
            legendFormat: '{{instance}} external',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Heap Usage',
        description:
          'V8 heap used vs total. Used approaching total with rising GC is the classic leak signature.',
        unit: 'bytes',
        min: 0,
        width: 8,
        targets: [
          {
            expr: `sum by (instance) (mator_nodejs_heap_size_used_bytes{${INST}})`,
            legendFormat: '{{instance}} used',
          },
          {
            expr: `sum by (instance) (mator_nodejs_heap_size_total_bytes{${INST}})`,
            legendFormat: '{{instance}} total',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Event Loop Lag',
        description:
          'How long a callback waits before running. Sustained p99 above ~100ms means the loop is blocked and every request is queueing behind it.',
        unit: 's',
        decimals: 4,
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max'],
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 0.1 },
          { color: 'red', value: 0.5 },
        ],
        targets: [
          {
            expr: `max by (instance) (mator_nodejs_eventloop_lag_mean_seconds{${INST}})`,
            legendFormat: '{{instance}} mean',
          },
          {
            expr: `max by (instance) (mator_nodejs_eventloop_lag_p99_seconds{${INST}})`,
            legendFormat: '{{instance}} p99',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Garbage Collection Rate',
        description:
          'GC time per second by collection kind. A rising "major" line alongside heap growth confirms memory pressure.',
        unit: 'percentunit',
        decimals: 4,
        min: 0,
        width: 12,
        targets: [
          {
            expr: `sum by (kind) (rate(mator_nodejs_gc_duration_seconds_sum{${INST}}[${RI}]))`,
            legendFormat: '{{kind}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Active Handles',
        description: 'Open handles (sockets, timers). Unbounded growth indicates a leak.',
        unit: 'short',
        decimals: 0,
        width: 6,
        targets: [
          {
            expr: `sum(mator_nodejs_active_handles_total{${INST}})`,
            legendFormat: 'handles',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Active Requests',
        description: 'Pending libuv requests (fs/dns/etc).',
        unit: 'short',
        decimals: 0,
        width: 6,
        targets: [
          {
            expr: `sum(mator_nodejs_active_requests_total{${INST}})`,
            legendFormat: 'requests',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    gauge(
      {
        title: 'Heap Utilisation',
        description: 'Heap used as a share of heap total.',
        unit: 'percent',
        decimals: 1,
        width: 6,
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 75 },
          { color: 'red', value: 90 },
        ],
        targets: [
          {
            expr:
              `100 * sum(mator_nodejs_heap_size_used_bytes{${INST}})\n` +
              `  / clamp_min(sum(mator_nodejs_heap_size_total_bytes{${INST}}), 1)`,
            legendFormat: 'heap %',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Instances Up',
        description: 'Number of backend processes currently reporting metrics.',
        unit: 'short',
        decimals: 0,
        width: 6,
        targets: [
          {
            expr: `count(count by (instance) (mator_process_start_time_seconds{${INST}}))`,
            legendFormat: 'instances',
          },
        ],
      },
      l,
    ),
  );

  return dashboard({
    uid: 'mator-backend-overview',
    title: 'Mator — Backend Overview',
    description:
      'API health: traffic, errors, latency percentiles and Node.js runtime. Start here during an incident.',
    tags: ['mator', 'backend', 'overview'],
    refresh: '30s',
    from: 'now-6h',
    panels,
    templating: [
      datasourceVar(),
      queryVar({
        name: 'instance',
        label: 'Instance',
        metric: 'mator_process_start_time_seconds',
        labelName: 'instance',
        description: 'Backend process(es) to include.',
      }),
      queryVar({
        name: 'method',
        label: 'HTTP Method',
        metric: 'mator_http_requests_total',
        labelName: 'method',
      }),
      queryVar({
        name: 'route',
        label: 'Route',
        metric: 'mator_http_requests_total',
        labelName: 'route',
      }),
    ],
    links: dashboardLinks(),
  });
}

/** Cross-links so an operator can move between the five dashboards. */
export function dashboardLinks(): unknown[] {
  return [
    {
      asDropdown: true,
      icon: 'external link',
      includeVars: true,
      keepTime: true,
      tags: ['mator'],
      targetBlank: false,
      title: 'Mator Dashboards',
      tooltip: 'Other Mator dashboards',
      type: 'dashboards',
      url: '',
    },
  ];
}

export { DS };
