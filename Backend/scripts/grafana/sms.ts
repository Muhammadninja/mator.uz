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
  table,
  timeseries,
} from './lib';
import { dashboardLinks } from './backend-overview';

/**
 * SMS — delivery health for the OTP/notification path.
 *
 * This is the most business-critical of the five: a failing SMS provider means
 * users cannot log in at all. The layout puts the failure signal first.
 *
 * Label model (from the backend):
 *   mator_sms_sent_total{provider, template}
 *   mator_sms_failed_total{provider, template, reason}
 *
 * `reason` is a CLOSED set produced by classifyFailure() — timeout, network,
 * auth, rate_limited, invalid_request, other, unknown — never a raw provider
 * message. That is what makes the failure-reason breakdown a stable, bounded
 * panel rather than a cardinality explosion.
 *
 * ── A note on the "sent" counter ──
 * `sms_sent_total` counts sends the PROVIDER ACCEPTED, not sends confirmed
 * delivered to a handset. Final delivery status arrives later via provider
 * callbacks and is not part of these metrics, so treat "sent" as "handed off
 * successfully".
 */
export function buildSms(): unknown {
  resetPanelIds();
  const l = new Layout();
  const panels: unknown[] = [];

  const PT = `provider=~"$provider", template=~"$template"`;
  const SENT = `{${INST}, ${PT}}`;
  const FAILED = `{${INST}, ${PT}}`;
  // Total attempts = accepted + failed. There is no single "attempts" counter,
  // so every rate/share below derives from the sum of the two.
  const TOTAL = (win: string) =>
    `(sum(rate(mator_sms_sent_total${SENT}[${win}])) or vector(0))` +
    ` + (sum(rate(mator_sms_failed_total${FAILED}[${win}])) or vector(0))`;

  // ── Summary ───────────────────────────────────────────────────────────────
  panels.push(row('Delivery Health', l));

  panels.push(
    gauge(
      {
        title: 'Success Rate',
        description:
          'Accepted / (accepted + failed) over the selected range. Below ~95% means users are struggling to receive OTPs.',
        unit: 'percent',
        decimals: 2,
        width: 5,
        height: 5,
        thresholds: [
          { color: 'red', value: null },
          { color: 'yellow', value: 95 },
          { color: 'green', value: 99 },
        ],
        noValue: '—',
        targets: [
          {
            expr:
              `100 * (sum(increase(mator_sms_sent_total${SENT}[$__range])) or vector(0))\n` +
              `  / clamp_min(\n` +
              `      (sum(increase(mator_sms_sent_total${SENT}[$__range])) or vector(0))\n` +
              `    + (sum(increase(mator_sms_failed_total${FAILED}[$__range])) or vector(0)),\n` +
              `    1e-9)`,
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
        description: 'Share of SMS attempts that failed over the selected range.',
        unit: 'percent',
        decimals: 2,
        width: 5,
        height: 5,
        colorMode: 'background',
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 1 },
          { color: 'red', value: 5 },
        ],
        targets: [
          {
            expr:
              `100 * (sum(increase(mator_sms_failed_total${FAILED}[$__range])) or vector(0))\n` +
              `  / clamp_min(\n` +
              `      (sum(increase(mator_sms_sent_total${SENT}[$__range])) or vector(0))\n` +
              `    + (sum(increase(mator_sms_failed_total${FAILED}[$__range])) or vector(0)),\n` +
              `    1e-9)`,
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
        title: 'SMS Sent/min',
        description: 'Current accepted-send throughput.',
        unit: 'short',
        decimals: 2,
        width: 4,
        height: 5,
        targets: [
          {
            expr: `60 * (sum(rate(mator_sms_sent_total${SENT}[${RI}])) or vector(0))`,
            legendFormat: 'sent/min',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'SMS Failed/min',
        description: 'Current failure throughput.',
        unit: 'short',
        decimals: 2,
        width: 4,
        height: 5,
        colorMode: 'background',
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 0.1 },
          { color: 'red', value: 1 },
        ],
        targets: [
          {
            expr: `60 * (sum(rate(mator_sms_failed_total${FAILED}[${RI}])) or vector(0))`,
            legendFormat: 'failed/min',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Total Sent',
        description: 'Accepted sends in the selected range.',
        unit: 'short',
        decimals: 0,
        width: 3,
        height: 5,
        targets: [
          {
            expr: `sum(increase(mator_sms_sent_total${SENT}[$__range]))`,
            legendFormat: 'sent',
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
        title: 'Total Failed',
        description: 'Failed sends in the selected range.',
        unit: 'short',
        decimals: 0,
        width: 3,
        height: 5,
        colorMode: 'background',
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 1 },
          { color: 'red', value: 20 },
        ],
        targets: [
          {
            expr: `sum(increase(mator_sms_failed_total${FAILED}[$__range]))`,
            legendFormat: 'failed',
            instant: true,
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
        title: 'SMS Sent vs Failed (per minute)',
        description: 'Delivery volume over time. A failure line that mirrors the sent line points at the provider, not at traffic.',
        unit: 'short',
        decimals: 2,
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr: `60 * (sum(rate(mator_sms_sent_total${SENT}[${RI}])) or vector(0))`,
            legendFormat: 'sent/min',
          },
          {
            expr: `60 * (sum(rate(mator_sms_failed_total${FAILED}[${RI}])) or vector(0))`,
            legendFormat: 'failed/min',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: 'sent/min' },
            properties: [{ id: 'color', value: { fixedColor: 'green', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: 'failed/min' },
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
        title: 'Success / Failure Rate %',
        description: 'Delivery success share over time.',
        unit: 'percent',
        decimals: 2,
        min: 0,
        max: 100,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'min', 'lastNotNull'],
        targets: [
          {
            expr:
              `100 * (sum(rate(mator_sms_sent_total${SENT}[${RI}])) or vector(0))\n` +
              `  / clamp_min(${TOTAL(RI)}, 1e-9)`,
            legendFormat: 'success %',
          },
          {
            expr:
              `100 * (sum(rate(mator_sms_failed_total${FAILED}[${RI}])) or vector(0))\n` +
              `  / clamp_min(${TOTAL(RI)}, 1e-9)`,
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

  // ── Provider ──────────────────────────────────────────────────────────────
  panels.push(row('By Provider', l));

  panels.push(
    timeseries(
      {
        title: 'Sent/min by Provider',
        description:
          'Throughput per aggregator (eskiz, playmobile, sayqal, log). Only one is active at a time unless SMS_PROVIDER changed mid-range.',
        unit: 'short',
        decimals: 2,
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'lastNotNull'],
        targets: [
          {
            expr: `60 * sum by (provider) (rate(mator_sms_sent_total${SENT}[${RI}]))`,
            legendFormat: '{{provider}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Failure Rate % by Provider',
        description:
          'Per-provider failure share — the panel that justifies switching SMS_PROVIDER during an incident.',
        unit: 'percent',
        decimals: 2,
        min: 0,
        max: 100,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr:
              `100 * (sum by (provider) (rate(mator_sms_failed_total${FAILED}[${RI}])) or vector(0))\n` +
              `  / clamp_min(\n` +
              `      (sum by (provider) (rate(mator_sms_sent_total${SENT}[${RI}])) or vector(0))\n` +
              `    + (sum by (provider) (rate(mator_sms_failed_total${FAILED}[${RI}])) or vector(0)),\n` +
              `    1e-9)`,
            legendFormat: '{{provider}}',
          },
        ],
      },
      l,
    ),
  );

  // ── Template ──────────────────────────────────────────────────────────────
  panels.push(row('By Template', l));

  panels.push(
    timeseries(
      {
        title: 'Sent/min by Template',
        description:
          'Volume per message type (otp, order_paid, …). "unknown" means the call site passed no template label.',
        unit: 'short',
        decimals: 2,
        min: 0,
        width: 12,
        stacking: true,
        fillOpacity: 40,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'lastNotNull'],
        targets: [
          {
            expr: `60 * sum by (template) (rate(mator_sms_sent_total${SENT}[${RI}]))`,
            legendFormat: '{{template}}',
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    table(
      {
        title: 'Volume by Provider & Template',
        description: 'Sent and failed totals for the selected range, broken out by both labels.',
        unit: 'short',
        decimals: 0,
        width: 12,
        targets: [
          {
            expr: `sum by (provider, template) (increase(mator_sms_sent_total${SENT}[$__range]))`,
            legendFormat: 'sent',
            instant: true,
            format: 'table',
            refId: 'A',
          },
          {
            expr: `sum by (provider, template) (increase(mator_sms_failed_total${FAILED}[$__range]))`,
            legendFormat: 'failed',
            instant: true,
            format: 'table',
            refId: 'B',
          },
        ],
        transformations: [
          {
            id: 'joinByField',
            options: { byField: 'provider', mode: 'outer' },
          },
          {
            id: 'organize',
            options: {
              excludeByName: { Time: true, 'Time 1': true, 'Time 2': true },
              renameByName: {
                'Value #A': 'Sent',
                'Value #B': 'Failed',
                'template 1': 'template',
              },
            },
          },
        ],
      },
      l,
    ),
  );

  // ── Failure reasons ───────────────────────────────────────────────────────
  panels.push(row('Failure Reasons', l));

  panels.push(
    timeseries(
      {
        title: 'Failures/min by Reason',
        description:
          'Closed set of classified reasons. "timeout"/"network" point at the aggregator or the link; "auth" means credentials; "rate_limited" means we are sending too fast.',
        unit: 'short',
        decimals: 3,
        min: 0,
        width: 12,
        stacking: true,
        fillOpacity: 50,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr: `60 * sum by (reason) (rate(mator_sms_failed_total${FAILED}[${RI}]))`,
            legendFormat: '{{reason}}',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: 'auth' },
            properties: [{ id: 'color', value: { fixedColor: 'dark-red', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: 'rate_limited' },
            properties: [{ id: 'color', value: { fixedColor: 'orange', mode: 'fixed' } }],
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    table(
      {
        title: 'Failure Reasons (selected range)',
        description: 'Ranked failure causes, with the provider that produced them.',
        unit: 'short',
        decimals: 0,
        width: 12,
        targets: [
          {
            expr: `sort_desc(sum by (reason, provider) (increase(mator_sms_failed_total${FAILED}[$__range])))`,
            instant: true,
            format: 'table',
          },
        ],
        transformations: [
          {
            id: 'organize',
            options: {
              excludeByName: { Time: true, __name__: true, instance: true, job: true },
              renameByName: { Value: 'Failures' },
            },
          },
          { id: 'sortBy', options: { fields: {}, sort: [{ field: 'Failures', desc: true }] } },
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
        title: 'SMS Queue Depth',
        description:
          'The sms queue that feeds delivery. Waiting growth here delays OTPs even when the provider is healthy.',
        unit: 'short',
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr: `max by (state) (mator_bullmq_jobs{${INST}, queue="sms", state=~"waiting|active|delayed|failed"})`,
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
        title: 'SMS Job Duration (P95)',
        description:
          'Time the SMS worker spends per job, including the provider HTTP call and its internal retries.',
        unit: 's',
        decimals: 3,
        min: 0,
        width: 12,
        targets: [
          {
            expr: `histogram_quantile(0.95, sum by (le) (rate(mator_bullmq_job_duration_seconds_bucket{${INST}, queue="sms"}[${RI}])))`,
            legendFormat: 'p95',
          },
          {
            expr:
              `sum(rate(mator_bullmq_job_duration_seconds_sum{${INST}, queue="sms"}[${RI}]))\n` +
              `  / clamp_min(sum(rate(mator_bullmq_job_duration_seconds_count{${INST}, queue="sms"}[${RI}])), 1e-9)`,
            legendFormat: 'average',
          },
        ],
      },
      l,
    ),
  );

  return dashboard({
    uid: 'mator-sms',
    title: 'Mator — SMS Delivery',
    description:
      'OTP and notification SMS: throughput, success/failure rates, and breakdowns by provider, template and failure reason.',
    tags: ['mator', 'sms', 'delivery'],
    refresh: '30s',
    from: 'now-12h',
    panels,
    templating: [
      datasourceVar(),
      queryVar({
        name: 'instance',
        label: 'Instance',
        metric: 'mator_sms_sent_total',
        labelName: 'instance',
      }),
      queryVar({
        name: 'provider',
        label: 'Provider',
        metric: 'mator_sms_sent_total',
        labelName: 'provider',
      }),
      queryVar({
        name: 'template',
        label: 'Template',
        metric: 'mator_sms_sent_total',
        labelName: 'template',
      }),
    ],
    links: dashboardLinks(),
  });
}
