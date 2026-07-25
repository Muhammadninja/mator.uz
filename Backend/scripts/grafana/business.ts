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
 * Business Metrics — the seller funnel, in the terms the product team uses.
 *
 * The funnel is: a seller starts a DRAFT → the draft is either PUBLISHED as a
 * live product, or EXPIRES via the TTL sweep. Those three counters plus SMS
 * volume are the whole dashboard.
 *
 * ── The one subtlety worth stating ──
 * "Publication success rate" here is published / (published + expired), NOT
 * published / created. A draft created seconds before the range ends has not had
 * time to do either, so dividing by `created` would report a misleadingly low
 * rate that improves on its own as drafts settle. Comparing the two TERMINAL
 * outcomes gives a number that is stable regardless of where the time window
 * happens to cut. The created-vs-settled gap is shown separately as
 * "Drafts In Flight" so the in-progress volume is still visible.
 */
export function buildBusiness(): unknown {
  resetPanelIds();
  const l = new Layout();
  const panels: unknown[] = [];

  const S = `{${INST}}`;
  const created = `sum(increase(mator_drafts_created_total${S}[$__range]))`;
  const published = `sum(increase(mator_products_published_total${S}[$__range]))`;
  const expired = `sum(increase(mator_drafts_expired_total${S}[$__range]))`;

  // ── Funnel summary ────────────────────────────────────────────────────────
  panels.push(row('Seller Funnel', l));

  panels.push(
    stat(
      {
        title: 'Drafts Created',
        description: 'Listings started by sellers in the selected range.',
        unit: 'short',
        decimals: 0,
        width: 4,
        height: 5,
        thresholds: [{ color: 'blue', value: null }],
        targets: [{ expr: created, legendFormat: 'created', instant: true }],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Products Published',
        description: 'Drafts that became live products in the selected range.',
        unit: 'short',
        decimals: 0,
        width: 4,
        height: 5,
        thresholds: [{ color: 'green', value: null }],
        targets: [{ expr: published, legendFormat: 'published', instant: true }],
      },
      l,
    ),
  );

  panels.push(
    stat(
      {
        title: 'Drafts Expired',
        description:
          'Drafts swept by the TTL cleanup without ever publishing — abandoned listings.',
        unit: 'short',
        decimals: 0,
        width: 4,
        height: 5,
        colorMode: 'background',
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 1 },
          { color: 'orange', value: 25 },
        ],
        targets: [{ expr: expired, legendFormat: 'expired', instant: true }],
      },
      l,
    ),
  );

  panels.push(
    gauge(
      {
        title: 'Publication Success Rate',
        description:
          'published / (published + expired) — the share of SETTLED drafts that made it live. Deliberately not divided by created, which would penalise drafts still in progress.',
        unit: 'percent',
        decimals: 2,
        width: 5,
        height: 5,
        thresholds: [
          { color: 'red', value: null },
          { color: 'yellow', value: 50 },
          { color: 'green', value: 75 },
        ],
        noValue: '—',
        targets: [
          {
            expr:
              `100 * (${published} or vector(0))\n` +
              `  / clamp_min((${published} or vector(0)) + (${expired} or vector(0)), 1e-9)`,
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
        title: 'Drafts In Flight',
        description:
          'created − (published + expired) over the range: drafts started but not yet settled. Can read negative if drafts from before the window settled inside it.',
        unit: 'short',
        decimals: 0,
        width: 4,
        height: 5,
        thresholds: [{ color: 'purple', value: null }],
        targets: [
          {
            expr: `(${created} or vector(0)) - ((${published} or vector(0)) + (${expired} or vector(0)))`,
            legendFormat: 'in flight',
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
        title: 'Publications/hour',
        description: 'Current publication throughput, extrapolated to an hourly rate.',
        unit: 'short',
        decimals: 2,
        width: 3,
        height: 5,
        targets: [
          {
            expr: `3600 * (sum(rate(mator_products_published_total${S}[${RI}])) or vector(0))`,
            legendFormat: 'per hour',
          },
        ],
      },
      l,
    ),
  );

  // ── Funnel over time ──────────────────────────────────────────────────────
  panels.push(row('Funnel Over Time', l));

  panels.push(
    timeseries(
      {
        title: 'Drafts & Publications per Hour',
        description:
          'The three funnel events as hourly rates. Created should track published with a lag; a widening gap means drafts are being abandoned.',
        unit: 'short',
        decimals: 2,
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max', 'lastNotNull'],
        targets: [
          {
            expr: `3600 * (sum(rate(mator_drafts_created_total${S}[${RI}])) or vector(0))`,
            legendFormat: 'created/h',
          },
          {
            expr: `3600 * (sum(rate(mator_products_published_total${S}[${RI}])) or vector(0))`,
            legendFormat: 'published/h',
          },
          {
            expr: `3600 * (sum(rate(mator_drafts_expired_total${S}[${RI}])) or vector(0))`,
            legendFormat: 'expired/h',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: 'created/h' },
            properties: [{ id: 'color', value: { fixedColor: 'blue', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: 'published/h' },
            properties: [{ id: 'color', value: { fixedColor: 'green', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: 'expired/h' },
            properties: [{ id: 'color', value: { fixedColor: 'orange', mode: 'fixed' } }],
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Publication Success Rate %',
        description:
          'Rolling published / (published + expired). Uses a 1h window so the line is readable rather than jumping on single events.',
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
              `100 * (sum(rate(mator_products_published_total${S}[1h])) or vector(0))\n` +
              `  / clamp_min(\n` +
              `      (sum(rate(mator_products_published_total${S}[1h])) or vector(0))\n` +
              `    + (sum(rate(mator_drafts_expired_total${S}[1h])) or vector(0)),\n` +
              `    1e-9)`,
            legendFormat: 'success % (1h window)',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: 'success % (1h window)' },
            properties: [{ id: 'color', value: { fixedColor: 'green', mode: 'fixed' } }],
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'Cumulative Funnel (selected range)',
        description:
          'Running totals across the window — the shape product asks about, without depending on process restarts.',
        unit: 'short',
        decimals: 0,
        min: 0,
        width: 24,
        fillOpacity: 20,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['lastNotNull'],
        targets: [
          {
            expr: `sum(increase(mator_drafts_created_total${S}[${RI}]))`,
            legendFormat: 'created',
          },
          {
            expr: `sum(increase(mator_products_published_total${S}[${RI}]))`,
            legendFormat: 'published',
          },
          {
            expr: `sum(increase(mator_drafts_expired_total${S}[${RI}]))`,
            legendFormat: 'expired',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: 'created' },
            properties: [{ id: 'color', value: { fixedColor: 'blue', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: 'published' },
            properties: [{ id: 'color', value: { fixedColor: 'green', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: 'expired' },
            properties: [{ id: 'color', value: { fixedColor: 'orange', mode: 'fixed' } }],
          },
        ],
      },
      l,
    ),
  );

  // ── SMS ───────────────────────────────────────────────────────────────────
  panels.push(row('SMS Volume', l));

  panels.push(
    stat(
      {
        title: 'SMS Sent',
        description: 'Messages accepted by a provider in the selected range.',
        unit: 'short',
        decimals: 0,
        width: 6,
        height: 4,
        thresholds: [{ color: 'green', value: null }],
        targets: [
          {
            expr: `sum(increase(mator_sms_sent_total${S}[$__range]))`,
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
        title: 'SMS Failed',
        description: 'Messages that failed to send in the selected range.',
        unit: 'short',
        decimals: 0,
        width: 6,
        height: 4,
        colorMode: 'background',
        thresholds: [
          { color: 'green', value: null },
          { color: 'yellow', value: 1 },
          { color: 'red', value: 20 },
        ],
        targets: [
          {
            expr: `sum(increase(mator_sms_failed_total${S}[$__range]))`,
            legendFormat: 'failed',
            instant: true,
          },
        ],
      },
      l,
    ),
  );

  panels.push(
    timeseries(
      {
        title: 'SMS Volume per Hour',
        description:
          'Business-level SMS volume. For provider/template/reason detail see the SMS dashboard.',
        unit: 'short',
        decimals: 2,
        min: 0,
        width: 12,
        legendMode: 'table',
        legendPlacement: 'right',
        legendCalcs: ['mean', 'max'],
        targets: [
          {
            expr: `3600 * (sum(rate(mator_sms_sent_total${S}[${RI}])) or vector(0))`,
            legendFormat: 'sent/h',
          },
          {
            expr: `3600 * (sum(rate(mator_sms_failed_total${S}[${RI}])) or vector(0))`,
            legendFormat: 'failed/h',
          },
        ],
        overrides: [
          {
            matcher: { id: 'byName', options: 'sent/h' },
            properties: [{ id: 'color', value: { fixedColor: 'green', mode: 'fixed' } }],
          },
          {
            matcher: { id: 'byName', options: 'failed/h' },
            properties: [{ id: 'color', value: { fixedColor: 'red', mode: 'fixed' } }],
          },
        ],
      },
      l,
    ),
  );

  return dashboard({
    uid: 'mator-business',
    title: 'Mator — Business Metrics',
    description:
      'Seller funnel: drafts created, products published, drafts expired, publication success rate and SMS volume.',
    tags: ['mator', 'business', 'product'],
    // Business trends are read over days, not minutes — a slower refresh and a
    // wider default window suit this dashboard better than the ops ones.
    refresh: '5m',
    from: 'now-7d',
    panels,
    templating: [
      datasourceVar(),
      queryVar({
        name: 'instance',
        label: 'Instance',
        metric: 'mator_drafts_created_total',
        labelName: 'instance',
      }),
    ],
    links: dashboardLinks(),
  });
}
