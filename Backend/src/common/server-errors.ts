/**
 * Every HTTP 5xx this process answered, counted where they all pass: the global
 * HttpExceptionFilter (main.ts installs it as `new`, outside DI, hence a module-level
 * store rather than a provider).
 *
 * Read by the alerting rule `http_5xx` (src/alerting/rules/http-errors.rule.ts), which
 * diffs two snapshots to get "errors in the last N minutes" and shows the most recent
 * one. The filter sees errors the HTTP metrics interceptor does not (a guard or a pipe
 * that throws runs before any interceptor), which is why the count is taken here.
 *
 * Bounded on every axis: totals are plain numbers, routes are route TEMPLATES (at most
 * MAX_ROUTES of them, the rest counted as `other`), and only the last MAX_RECENT errors
 * are kept in detail. Recording never throws.
 */

/** One answered 5xx, as the alert shows it. */
export interface ServerErrorEntry {
  /** Epoch ms. */
  at: number;
  /** `POST /v1/orders` — the route template, never the raw URL. */
  route: string;
  status: number;
  /** `TypeError: Cannot read properties of undefined`, trimmed and capped. */
  message: string;
  requestId?: string;
}

/** Cumulative counts at one moment, for windowed diffs. */
export interface ServerErrorSnapshot {
  takenAt: number;
  total: number;
  byRoute: ReadonlyMap<string, number>;
  byStatus: ReadonlyMap<number, number>;
}

const MAX_ROUTES = 200;
const MAX_RECENT = 20;
const MAX_MESSAGE_CHARS = 300;
export const OTHER_ROUTE = 'other';

export class ServerErrorLog {
  private total = 0;
  private readonly byRoute = new Map<string, number>();
  private readonly byStatus = new Map<number, number>();
  private readonly recent: ServerErrorEntry[] = [];

  record(entry: ServerErrorEntry): void {
    try {
      this.total += 1;
      const route =
        this.byRoute.has(entry.route) || this.byRoute.size < MAX_ROUTES
          ? entry.route
          : OTHER_ROUTE;
      this.byRoute.set(route, (this.byRoute.get(route) ?? 0) + 1);
      this.byStatus.set(
        entry.status,
        (this.byStatus.get(entry.status) ?? 0) + 1,
      );
      this.recent.push({
        ...entry,
        message: entry.message
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_MESSAGE_CHARS),
      });
      if (this.recent.length > MAX_RECENT) this.recent.shift();
    } catch {
      // Counting an error must never become a second one.
    }
  }

  snapshot(now = Date.now()): ServerErrorSnapshot {
    return {
      takenAt: now,
      total: this.total,
      byRoute: new Map(this.byRoute),
      byStatus: new Map(this.byStatus),
    };
  }

  /** The most recent error at or after `since`, if any. */
  latestSince(since: number): ServerErrorEntry | undefined {
    const last = this.recent[this.recent.length - 1];
    return last !== undefined && last.at >= since ? last : undefined;
  }

  /** For tests only. */
  reset(): void {
    this.total = 0;
    this.byRoute.clear();
    this.byStatus.clear();
    this.recent.length = 0;
  }
}

/** The process-wide log the filter writes and the alert rule reads. */
export const serverErrors = new ServerErrorLog();

/** `POST /v1/orders/:id`, or `POST (unmatched)` when routing never matched. */
export function routeTemplate(req: {
  method?: string;
  baseUrl?: string;
  route?: { path?: unknown };
}): string {
  const method = (req.method ?? 'UNKNOWN').toUpperCase();
  const path = req.route?.path;
  return typeof path === 'string' && path.length > 0
    ? `${method} ${req.baseUrl ?? ''}${path}`
    : `${method} (unmatched)`;
}

/** `TypeError: boom` for an Error, the string form otherwise. */
export function describeError(exception: unknown): string {
  if (exception instanceof Error) {
    return exception.message
      ? `${exception.name}: ${exception.message}`
      : exception.name;
  }
  return String(exception);
}
