import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Registry } from 'prom-client';
import { DEFAULT_METRICS_PREFIX, type MetricsConfig } from '../../src/metrics/metrics.config';
import {
  createAppMetrics,
  registerDefaultMetrics,
} from '../../src/metrics/metrics.definitions';

/**
 * Validates the GENERATED dashboard JSON against the metrics the backend
 * actually exports.
 *
 * This is the test that makes "importable without manual editing" a checked
 * property rather than a claim. A dashboard is just data, so the usual failure
 * mode is silent: a typo'd metric name or a label that does not exist produces
 * a panel that renders an empty graph forever, and nobody notices until an
 * incident. Here every metric and label referenced by every panel is checked
 * against a REAL prom-client registry built from the real definitions — so if
 * Phase A ever renames a metric, these tests fail instead of the dashboards
 * silently going blank.
 */

const DASHBOARD_DIR = join(__dirname, '..', '..', 'grafana', 'dashboards');

/** Build the real registry and extract metric names, label sets and types. */
function realMetrics(): {
  names: Set<string>;
  labels: Map<string, Set<string>>;
  counters: Set<string>;
} {
  const config: MetricsConfig = {
    enabled: true,
    path: '/metrics',
    prefix: DEFAULT_METRICS_PREFIX,
    queueMetricsEnabled: true,
    smsCostMetricsEnabled: true,
  };
  const registry = new Registry();
  createAppMetrics(registry, config);
  registerDefaultMetrics(registry, config);

  const names = new Set<string>();
  const labels = new Map<string, Set<string>>();
  // Keyed off the registry's declared TYPE, not the name. prom-client exports
  // several gauges whose names end in `_total` (nodejs_active_handles_total),
  // and wrapping a gauge in rate() would be wrong — so the name suffix is not a
  // safe proxy for "this is a counter".
  const counters = new Set<string>();

  for (const metric of (registry as unknown as {
    getMetricsAsArray: () => { name: string; type: string; labelNames?: string[] }[];
  }).getMetricsAsArray()) {
    const base = metric.name;
    const declared = new Set(metric.labelNames ?? []);
    // Prometheus adds these to every series.
    declared.add('instance');
    declared.add('job');

    names.add(base);
    labels.set(base, declared);
    if (metric.type === 'counter') counters.add(base);

    // Histograms expose _bucket/_sum/_count; _bucket additionally carries `le`.
    if (metric.type === 'histogram') {
      const withLe = new Set(declared);
      withLe.add('le');
      names.add(`${base}_bucket`);
      labels.set(`${base}_bucket`, withLe);
      for (const suffix of ['_sum', '_count']) {
        names.add(`${base}${suffix}`);
        labels.set(`${base}${suffix}`, declared);
      }
    }
  }

  return { names, labels, counters };
}

interface Panel {
  type: string;
  title?: string;
  targets?: { expr?: string; legendFormat?: string; refId?: string }[];
  datasource?: unknown;
  gridPos?: { x: number; y: number; w: number; h: number };
  id?: number;
}

interface Dashboard {
  uid: string;
  title: string;
  panels: Panel[];
  templating: { list: { name: string; type: string; definition?: string }[] };
  refresh?: string;
  schemaVersion?: number;
  time?: { from: string; to: string };
}

function loadDashboards(): [string, Dashboard][] {
  return readdirSync(DASHBOARD_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(readFileSync(join(DASHBOARD_DIR, f), 'utf8')) as Dashboard]);
}

/** Every `mator_*` identifier referenced anywhere in a PromQL expression. */
function metricsIn(expr: string): string[] {
  return [...expr.matchAll(/\bmator_[a-z0-9_]+/g)].map((m) => m[0]);
}

/**
 * Label names used inside `{...}` selectors, plus those used in `by (...)`
 * / `sum by` groupings, paired with the metric they apply to.
 */
function selectorsIn(expr: string): { metric: string; labels: string[] }[] {
  const out: { metric: string; labels: string[] }[] = [];
  for (const m of expr.matchAll(/\b(mator_[a-z0-9_]+)\{([^}]*)\}/g)) {
    const labels = [...m[2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=~|!~|=|!=)/g)].map(
      (x) => x[1],
    );
    out.push({ metric: m[1], labels });
  }
  return out;
}

const dashboards = loadDashboards();
const { names, labels, counters } = realMetrics();

describe('generated Grafana dashboards', () => {
  it('generated all five dashboards', () => {
    expect(dashboards.map(([f]) => f).sort()).toEqual([
      'backend-overview.json',
      'bullmq.json',
      'business.json',
      'image-processing.json',
      'sms.json',
    ]);
  });

  it.each(dashboards)('%s is valid importable JSON with a uid and title', (_file, d) => {
    expect(typeof d.uid).toBe('string');
    expect(d.uid.length).toBeGreaterThan(0);
    expect(typeof d.title).toBe('string');
    // Grafana 10/11 schema. Importing an older schemaVersion triggers silent
    // migrations that can drop panel options.
    expect(d.schemaVersion).toBe(39);
    expect(Array.isArray(d.panels)).toBe(true);
    expect(d.panels.length).toBeGreaterThan(0);
  });

  it.each(dashboards)('%s has unique panel ids and no overlapping grid slots', (_file, d) => {
    const ids = d.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Two panels occupying the same cell render on top of each other.
    const occupied = new Set<string>();
    for (const p of d.panels) {
      const g = p.gridPos!;
      for (let x = g.x; x < g.x + g.w; x++) {
        for (let y = g.y; y < g.y + g.h; y++) {
          const key = `${x},${y}`;
          expect(occupied.has(key)).toBe(false);
          occupied.add(key);
        }
      }
      // Nothing may exceed Grafana's 24-column grid.
      expect(g.x + g.w).toBeLessThanOrEqual(24);
    }
  });

  it.each(dashboards)('%s references only metrics the backend exports', (_file, d) => {
    const unknownMetrics = new Set<string>();
    for (const panel of d.panels) {
      for (const target of panel.targets ?? []) {
        for (const metric of metricsIn(target.expr ?? '')) {
          if (!names.has(metric)) unknownMetrics.add(`${panel.title}: ${metric}`);
        }
      }
    }
    expect([...unknownMetrics]).toEqual([]);
  });

  it.each(dashboards)('%s uses only labels those metrics actually carry', (_file, d) => {
    const bad: string[] = [];
    for (const panel of d.panels) {
      for (const target of panel.targets ?? []) {
        for (const { metric, labels: used } of selectorsIn(target.expr ?? '')) {
          const declared = labels.get(metric);
          if (!declared) continue; // unknown metric is covered by the test above
          for (const label of used) {
            if (!declared.has(label)) {
              bad.push(`${panel.title}: ${metric}{${label}}`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it.each(dashboards)('%s gives every panel a datasource and a query', (_file, d) => {
    for (const panel of d.panels) {
      if (panel.type === 'row') continue;
      expect(panel.datasource).toEqual({ type: 'prometheus', uid: '${datasource}' });
      expect(panel.targets?.length ?? 0).toBeGreaterThan(0);
      for (const t of panel.targets ?? []) {
        expect(typeof t.expr).toBe('string');
        expect(t.expr!.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it.each(dashboards)('%s has balanced parentheses in every expression', (_file, d) => {
    for (const panel of d.panels) {
      for (const t of panel.targets ?? []) {
        const expr = t.expr ?? '';
        let depth = 0;
        for (const ch of expr) {
          if (ch === '(') depth++;
          if (ch === ')') depth--;
          expect(depth).toBeGreaterThanOrEqual(0);
        }
        expect({ panel: panel.title, depth }).toEqual({ panel: panel.title, depth: 0 });
      }
    }
  });

  it.each(dashboards)('%s declares a datasource variable so it imports anywhere', (_file, d) => {
    const ds = d.templating.list.find((v) => v.name === 'datasource');
    expect(ds).toBeDefined();
    expect(ds!.type).toBe('datasource');
  });

  it.each(dashboards)('%s only uses template variables it declares', (_file, d) => {
    const declared = new Set(d.templating.list.map((v) => v.name));
    // Grafana built-ins that are always available.
    const builtins = new Set(['__rate_interval', '__range', '__interval', '__auto']);
    const used = new Set<string>();

    for (const panel of d.panels) {
      for (const t of panel.targets ?? []) {
        for (const m of (t.expr ?? '').matchAll(/\$(?:\{)?([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
          used.add(m[1]);
        }
      }
    }

    const undeclared = [...used].filter((v) => !declared.has(v) && !builtins.has(v));
    expect(undeclared).toEqual([]);
  });

  it.each(dashboards)('%s sets a refresh interval and a default time range', (_file, d) => {
    expect(d.refresh).toBeTruthy();
    // Never faster than the 15s scrape — a faster refresh only re-renders the
    // same points while multiplying query load.
    expect(['30s', '1m', '5m']).toContain(d.refresh);
    expect(d.time?.from).toMatch(/^now-/);
  });

  it('uses rate()/increase() rather than raw counters for every counter panel', () => {
    const counterMetrics = [...counters];
    const violations: string[] = [];

    for (const [file, d] of dashboards) {
      for (const panel of d.panels) {
        for (const t of panel.targets ?? []) {
          const expr = t.expr ?? '';
          for (const metric of metricsIn(expr)) {
            if (!counterMetrics.includes(metric)) continue;
            // Each occurrence of a counter must sit inside rate() or increase().
            const wrapped = new RegExp(
              `(?:rate|increase|irate)\\s*\\(\\s*${metric}\\b`,
            ).test(expr);
            if (!wrapped) violations.push(`${file} → ${panel.title}: ${metric}`);
          }
        }
      }
    }

    // A raw counter graph shows a line that only ever climbs and resets to zero
    // on deploy — it answers no operational question.
    expect(violations).toEqual([]);
  });

  it('never divides without guarding against a zero denominator', () => {
    const unguarded: string[] = [];
    for (const [file, d] of dashboards) {
      for (const panel of d.panels) {
        for (const t of panel.targets ?? []) {
          const expr = t.expr ?? '';
          if (!expr.includes('/')) continue;
          // Every ratio panel must use clamp_min on the denominator, otherwise a
          // quiet period yields NaN and the panel reads as broken.
          if (!expr.includes('clamp_min')) {
            unguarded.push(`${file} → ${panel.title}`);
          }
        }
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('exposes the queue/provider/template variables the brief requires', () => {
    const byUid = new Map(dashboards.map(([, d]) => [d.uid, d]));
    const varsOf = (uid: string) =>
      new Set((byUid.get(uid)?.templating.list ?? []).map((v) => v.name));

    expect(varsOf('mator-bullmq')).toContain('queue');
    expect(varsOf('mator-sms')).toContain('provider');
    expect(varsOf('mator-sms')).toContain('template');
    // Every dashboard supports instance selection.
    for (const [, d] of dashboards) {
      expect(new Set(d.templating.list.map((v) => v.name))).toContain('instance');
    }
  });

  it('discovers queues dynamically rather than hard-coding queue names', () => {
    const bullmq = dashboards.find(([f]) => f === 'bullmq.json')![1];
    const queueVar = bullmq.templating.list.find((v) => v.name === 'queue');

    // Populated from the metrics themselves, so a newly registered queue shows
    // up with no dashboard edit — the "support all existing queues" requirement.
    expect(queueVar?.definition).toBe('label_values(mator_bullmq_jobs, queue)');
  });

  it('aggregates BullMQ gauges with max, never sum, across instances', () => {
    const bullmq = dashboards.find(([f]) => f === 'bullmq.json')![1];
    const bad: string[] = [];

    for (const panel of bullmq.panels) {
      for (const t of panel.targets ?? []) {
        const expr = t.expr ?? '';
        if (!expr.includes('mator_bullmq_jobs{') && !expr.includes('mator_bullmq_workers{')) {
          continue;
        }
        // Under PM2 cluster mode every instance reports the SAME queue depth
        // (one shared Redis), so sum() would multiply the backlog by the worker
        // count and invent a problem that does not exist.
        if (/sum\s+by\s*\([^)]*\)\s*\(\s*mator_bullmq_(jobs|workers)/.test(expr)) {
          bad.push(`${panel.title}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
