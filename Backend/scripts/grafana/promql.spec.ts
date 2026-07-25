import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parser } from '@prometheus-io/lezer-promql';

/**
 * Parses every dashboard expression with Prometheus's OWN PromQL grammar
 * (@prometheus-io/lezer-promql — the same parser Grafana's query editor uses).
 *
 * The other spec checks that we reference real metrics and real labels. This one
 * checks the thing that file cannot: that each expression is syntactically valid
 * PromQL at all. Without it, a stray parenthesis or a malformed `sum by(...)`
 * ships as a panel that returns a parse error at query time — visible only when
 * somebody opens the dashboard, which during an incident is the worst moment to
 * discover it.
 *
 * Grafana variables (`$queue`, `$__rate_interval`, `$__range`) are NOT PromQL,
 * so they are substituted with representative literals first — exactly what
 * Grafana does before sending the query to Prometheus.
 */

const DASHBOARD_DIR = join(__dirname, '..', '..', 'grafana', 'dashboards');

/** Replace Grafana template variables with what Grafana interpolates at query time. */
function interpolate(expr: string): string {
  return (
    expr
      // Duration variables become a concrete window.
      .replace(/\$__rate_interval/g, '5m')
      .replace(/\$__interval/g, '1m')
      .replace(/\$__range/g, '6h')
      // Multi-value variables interpolate into a regex alternation inside a
      // label matcher, e.g. queue=~"sms|image-processing".
      .replace(/\$\{?(queue|provider|template|instance|method|route)\}?/g, 'a|b')
  );
}

interface Panel {
  title?: string;
  targets?: { expr?: string }[];
}

const dashboards: [string, { panels: Panel[] }][] = readdirSync(DASHBOARD_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [
    f,
    JSON.parse(readFileSync(join(DASHBOARD_DIR, f), 'utf8')) as { panels: Panel[] },
  ]);

/** Collect every expression across all dashboards as [file, panel, expr]. */
const allExpressions: [string, string, string][] = [];
for (const [file, d] of dashboards) {
  for (const panel of d.panels) {
    for (const t of panel.targets ?? []) {
      if (t.expr) allExpressions.push([file, panel.title ?? '(untitled)', t.expr]);
    }
  }
}

/** Walk the parse tree and return the positions of any error nodes. */
function parseErrors(expr: string): string[] {
  const tree = parser.parse(expr);
  const errors: string[] = [];
  const cursor = tree.cursor();
  do {
    if (cursor.type.isError) {
      const context = expr.slice(Math.max(0, cursor.from - 30), cursor.from + 30);
      errors.push(`at offset ${cursor.from}: …${context}…`);
    }
  } while (cursor.next());
  return errors;
}

describe('PromQL syntax (Prometheus grammar)', () => {
  it('found expressions to check', () => {
    // Guards against the suite silently passing because it parsed nothing.
    expect(allExpressions.length).toBeGreaterThan(80);
  });

  it.each(allExpressions)('%s → %s parses', (_file, _panel, expr) => {
    const errors = parseErrors(interpolate(expr));
    expect(errors).toEqual([]);
  });

  it('rejects a deliberately broken expression (the check really works)', () => {
    // Negative control: proves these assertions can actually fail, rather than
    // the parser silently accepting everything.
    expect(parseErrors('sum(rate(foo[5m])').length).toBeGreaterThan(0);
    expect(parseErrors('sum by (((foo)').length).toBeGreaterThan(0);
  });
});
