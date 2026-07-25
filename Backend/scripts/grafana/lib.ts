/**
 * Shared builders for the Mator Grafana dashboards.
 *
 * The dashboards are GENERATED rather than hand-written JSON. A Grafana
 * dashboard is ~500 lines of deeply-nested, highly repetitive JSON per file;
 * hand-maintaining five of them means every fix (a unit, a threshold, a
 * datasource uid) has to be applied in dozens of places by hand, and a single
 * misplaced brace is only discovered at import time. Building them from typed
 * helpers means a panel's PromQL and its unit are declared once, and the
 * generator is what guarantees every panel carries a datasource, a grid slot
 * and a unique id.
 *
 * Everything here targets the Grafana 10/11 dashboard JSON schema (schemaVersion
 * 39), which is what current Grafana imports natively and older 9.x still
 * accepts for these panel types.
 */

/** Prometheus datasource, referenced by a dashboard VARIABLE (see datasourceVar). */
export const DS = { type: 'prometheus', uid: '${datasource}' } as const;

/** Grafana's standard 24-column grid. */
export const GRID_WIDTH = 24;

export interface Target {
  expr: string;
  legendFormat?: string;
  refId?: string;
  /** Instant queries power stat panels that show "the value now". */
  instant?: boolean;
  range?: boolean;
  interval?: string;
  format?: 'time_series' | 'table' | 'heatmap';
}

export interface PanelOptions {
  title: string;
  description?: string;
  targets: Target[];
  /** Grafana field unit, e.g. 'reqps', 'percent', 's', 'bytes'. */
  unit?: string;
  decimals?: number;
  min?: number;
  max?: number;
  /** [green-below, yellow-at, red-at] style steps. */
  thresholds?: { color: string; value: number | null }[];
  width?: number;
  height?: number;
  legendMode?: 'list' | 'table' | 'hidden';
  legendPlacement?: 'bottom' | 'right';
  legendCalcs?: string[];
  stacking?: boolean;
  fillOpacity?: number;
  drawStyle?: 'line' | 'bars' | 'points';
  /** Stat panel colour mode. */
  colorMode?: 'value' | 'background' | 'none';
  graphMode?: 'area' | 'none';
  textSize?: number;
  /** Explicit override list for per-series colours/units. */
  overrides?: unknown[];
  /** Reduce options for stat panels. */
  reducer?: string;
  noValue?: string;
  maxDataPoints?: number;
}

let panelId = 0;
/** Reset before building each dashboard so ids are stable across runs. */
export function resetPanelIds(): void {
  panelId = 0;
}
function nextId(): number {
  return ++panelId;
}

/**
 * Layout cursor: lays panels left-to-right, wrapping at 24 columns.
 *
 * Tracks `rowHeight` — the TALLEST panel placed in the current row — and
 * advances `y` by that when wrapping. Advancing by the incoming panel's height
 * instead is subtly wrong: a row of 8-high graphs followed by a 4-high stat
 * would move the cursor down only 4, and the stat would be drawn on top of the
 * graph above it. Grafana renders such overlaps by silently shifting panels, so
 * the damage shows up as a scrambled dashboard rather than an error.
 */
export class Layout {
  private x = 0;
  private y = 0;
  private rowHeight = 0;

  place(width: number, height: number): { x: number; y: number; w: number; h: number } {
    const w = Math.min(width, GRID_WIDTH);
    if (this.x + w > GRID_WIDTH) this.wrap();

    const pos = { x: this.x, y: this.y, w, h: height };
    this.x += w;
    this.rowHeight = Math.max(this.rowHeight, height);
    if (this.x >= GRID_WIDTH) this.wrap();
    return pos;
  }

  /** Close the current row and move the cursor below its tallest panel. */
  private wrap(): void {
    this.x = 0;
    this.y += this.rowHeight;
    this.rowHeight = 0;
  }

  /** Force a new row (used before a row header). */
  newRow(): void {
    if (this.x !== 0) this.wrap();
  }

  advance(h: number): void {
    this.y += h;
  }

  get cursorY(): number {
    return this.y;
  }
}

function buildTargets(targets: Target[]): unknown[] {
  return targets.map((t, i) => ({
    datasource: DS,
    editorMode: 'code',
    expr: t.expr,
    legendFormat: t.legendFormat ?? '__auto',
    range: t.instant ? false : (t.range ?? true),
    instant: t.instant ?? false,
    refId: t.refId ?? String.fromCharCode(65 + i),
    ...(t.interval ? { interval: t.interval } : {}),
    ...(t.format ? { format: t.format } : {}),
  }));
}

function defaultsFor(o: PanelOptions) {
  return {
    color: { mode: 'palette-classic' },
    custom: {
      axisBorderShow: false,
      axisCenteredZero: false,
      axisColorMode: 'text',
      axisLabel: '',
      axisPlacement: 'auto',
      barAlignment: 0,
      drawStyle: o.drawStyle ?? 'line',
      fillOpacity: o.fillOpacity ?? 10,
      gradientMode: 'none',
      hideFrom: { legend: false, tooltip: false, viz: false },
      insertNulls: false,
      lineInterpolation: 'smooth',
      lineWidth: 2,
      pointSize: 5,
      scaleDistribution: { type: 'linear' },
      showPoints: 'never',
      spanNulls: false,
      stacking: {
        group: 'A',
        mode: o.stacking ? 'normal' : 'none',
      },
      thresholdsStyle: { mode: 'off' },
    },
    mappings: [],
    thresholds: {
      mode: 'absolute',
      steps: o.thresholds ?? [{ color: 'green', value: null }],
    },
    ...(o.unit ? { unit: o.unit } : {}),
    ...(o.decimals !== undefined ? { decimals: o.decimals } : {}),
    ...(o.min !== undefined ? { min: o.min } : {}),
    ...(o.max !== undefined ? { max: o.max } : {}),
    // "No data" must read as an explicit zero/none rather than a blank panel —
    // an empty graph is indistinguishable from a broken query to an operator.
    ...(o.noValue ? { noValue: o.noValue } : {}),
  };
}

/** A time-series (graph) panel. */
export function timeseries(o: PanelOptions, layout: Layout): unknown {
  const gridPos = layout.place(o.width ?? 12, o.height ?? 8);
  return {
    id: nextId(),
    type: 'timeseries',
    title: o.title,
    ...(o.description ? { description: o.description } : {}),
    datasource: DS,
    gridPos,
    ...(o.maxDataPoints ? { maxDataPoints: o.maxDataPoints } : {}),
    fieldConfig: {
      defaults: defaultsFor(o),
      overrides: o.overrides ?? [],
    },
    options: {
      legend: {
        calcs: o.legendCalcs ?? [],
        displayMode: o.legendMode ?? 'list',
        placement: o.legendPlacement ?? 'bottom',
        showLegend: o.legendMode !== 'hidden',
      },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
    targets: buildTargets(o.targets),
  };
}

/** A single-value stat panel. */
export function stat(o: PanelOptions, layout: Layout): unknown {
  const gridPos = layout.place(o.width ?? 4, o.height ?? 4);
  return {
    id: nextId(),
    type: 'stat',
    title: o.title,
    ...(o.description ? { description: o.description } : {}),
    datasource: DS,
    gridPos,
    fieldConfig: {
      defaults: {
        color: { mode: o.thresholds ? 'thresholds' : 'fixed', fixedColor: 'text' },
        mappings: [],
        thresholds: {
          mode: 'absolute',
          steps: o.thresholds ?? [{ color: 'green', value: null }],
        },
        ...(o.unit ? { unit: o.unit } : {}),
        ...(o.decimals !== undefined ? { decimals: o.decimals } : {}),
        ...(o.min !== undefined ? { min: o.min } : {}),
        ...(o.max !== undefined ? { max: o.max } : {}),
        noValue: o.noValue ?? '0',
      },
      overrides: o.overrides ?? [],
    },
    options: {
      colorMode: o.colorMode ?? 'value',
      graphMode: o.graphMode ?? 'area',
      justifyMode: 'auto',
      orientation: 'auto',
      reduceOptions: {
        calcs: [o.reducer ?? 'lastNotNull'],
        fields: '',
        values: false,
      },
      showPercentChange: false,
      textMode: 'auto',
      wideLayout: true,
      ...(o.textSize ? { text: { valueSize: o.textSize } } : {}),
    },
    targets: buildTargets(o.targets),
  };
}

/** A gauge panel — used where a value has a meaningful 0–100 range. */
export function gauge(o: PanelOptions, layout: Layout): unknown {
  const gridPos = layout.place(o.width ?? 4, o.height ?? 4);
  return {
    id: nextId(),
    type: 'gauge',
    title: o.title,
    ...(o.description ? { description: o.description } : {}),
    datasource: DS,
    gridPos,
    fieldConfig: {
      defaults: {
        color: { mode: 'thresholds' },
        mappings: [],
        thresholds: {
          mode: 'absolute',
          steps: o.thresholds ?? [{ color: 'green', value: null }],
        },
        ...(o.unit ? { unit: o.unit } : {}),
        ...(o.decimals !== undefined ? { decimals: o.decimals } : {}),
        min: o.min ?? 0,
        max: o.max ?? 100,
        noValue: o.noValue ?? '0',
      },
      overrides: o.overrides ?? [],
    },
    options: {
      minVizHeight: 75,
      minVizWidth: 75,
      orientation: 'auto',
      reduceOptions: {
        calcs: [o.reducer ?? 'lastNotNull'],
        fields: '',
        values: false,
      },
      showThresholdLabels: false,
      showThresholdMarkers: true,
      sizing: 'auto',
    },
    targets: buildTargets(o.targets),
  };
}

/** A table panel, used for breakdowns (top-N style). */
export function table(
  o: PanelOptions & { transformations?: unknown[] },
  layout: Layout,
): unknown {
  const gridPos = layout.place(o.width ?? 12, o.height ?? 8);
  return {
    id: nextId(),
    type: 'table',
    title: o.title,
    ...(o.description ? { description: o.description } : {}),
    datasource: DS,
    gridPos,
    fieldConfig: {
      defaults: {
        color: { mode: 'thresholds' },
        custom: {
          align: 'auto',
          cellOptions: { type: 'auto' },
          inspect: false,
        },
        mappings: [],
        thresholds: {
          mode: 'absolute',
          steps: o.thresholds ?? [{ color: 'green', value: null }],
        },
        ...(o.unit ? { unit: o.unit } : {}),
        ...(o.decimals !== undefined ? { decimals: o.decimals } : {}),
        noValue: o.noValue ?? 'No data',
      },
      overrides: o.overrides ?? [],
    },
    options: {
      cellHeight: 'sm',
      footer: { countRows: false, fields: '', reducer: ['sum'], show: false },
      showHeader: true,
      sortBy: [],
    },
    transformations: o.transformations ?? [],
    targets: buildTargets(o.targets),
  };
}

/** A collapsible row header, used to group panels logically. */
export function row(title: string, layout: Layout): unknown {
  layout.newRow();
  const y = layout.cursorY;
  layout.advance(1);
  return {
    id: nextId(),
    type: 'row',
    title,
    collapsed: false,
    gridPos: { h: 1, w: GRID_WIDTH, x: 0, y },
    panels: [],
  };
}

// ── Template variables ──────────────────────────────────────────────────────

/**
 * The datasource picker. Every panel references `${datasource}` rather than a
 * hard-coded uid, which is what makes these files importable into ANY Grafana
 * without hand-editing — the operator picks their Prometheus at import time.
 */
export function datasourceVar(): unknown {
  return {
    current: {},
    hide: 0,
    includeAll: false,
    label: 'Datasource',
    multi: false,
    name: 'datasource',
    options: [],
    query: 'prometheus',
    refresh: 1,
    regex: '',
    skipUrlSync: false,
    type: 'datasource',
  };
}

/**
 * A label_values() variable. `refresh: 2` re-resolves on every time-range
 * change, so a queue/provider that only appears later still shows up without a
 * dashboard reload.
 */
export function queryVar(opts: {
  name: string;
  label: string;
  metric: string;
  labelName: string;
  multi?: boolean;
  includeAll?: boolean;
  allValue?: string;
  description?: string;
}): unknown {
  return {
    allValue: opts.allValue ?? '.*',
    current: {},
    ...(opts.description ? { description: opts.description } : {}),
    datasource: DS,
    definition: `label_values(${opts.metric}, ${opts.labelName})`,
    hide: 0,
    includeAll: opts.includeAll ?? true,
    label: opts.label,
    multi: opts.multi ?? true,
    name: opts.name,
    options: [],
    query: {
      qryType: 1,
      query: `label_values(${opts.metric}, ${opts.labelName})`,
      refId: `${opts.name}Variable`,
    },
    refresh: 2,
    regex: '',
    skipUrlSync: false,
    sort: 1,
    type: 'query',
  };
}

export interface DashboardOptions {
  uid: string;
  title: string;
  description: string;
  tags: string[];
  panels: unknown[];
  templating: unknown[];
  refresh?: string;
  from?: string;
  links?: unknown[];
}

/** Assemble the final dashboard object. */
export function dashboard(o: DashboardOptions): unknown {
  return {
    annotations: {
      list: [
        {
          builtIn: 1,
          datasource: { type: 'grafana', uid: '-- Grafana --' },
          enable: true,
          hide: true,
          iconColor: 'rgba(0, 211, 255, 1)',
          name: 'Annotations & Alerts',
          type: 'dashboard',
        },
      ],
    },
    description: o.description,
    editable: true,
    fiscalYearStartMonth: 0,
    graphTooltip: 1, // shared crosshair across panels
    links: o.links ?? [],
    panels: o.panels,
    preload: false,
    refresh: o.refresh ?? '30s',
    schemaVersion: 39,
    tags: o.tags,
    templating: { list: o.templating },
    time: { from: o.from ?? 'now-6h', to: 'now' },
    timepicker: {
      refresh_intervals: ['10s', '30s', '1m', '5m', '15m', '30m', '1h'],
    },
    timezone: 'browser',
    title: o.title,
    uid: o.uid,
    version: 1,
    weekStart: '',
  };
}

// ── PromQL fragments ────────────────────────────────────────────────────────

/**
 * The instance selector every query carries. Uses `=~` with the `$instance`
 * variable so "All" (`.*`) works, and so multi-select produces a valid regex.
 */
export const INST = 'instance=~"$instance"';

/**
 * `$__rate_interval` is Grafana's built-in, scrape-interval-aware window. It is
 * the correct choice over a hard-coded [5m]: it guarantees at least 4 scrapes
 * per rate() window at ANY zoom level, so the graph neither goes empty when
 * zoomed in nor lies when zoomed out. Hard-coding [5m] breaks at both extremes.
 */
export const RI = '$__rate_interval';
