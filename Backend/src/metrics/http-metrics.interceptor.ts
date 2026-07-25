import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HttpArgumentsHost } from '@nestjs/common/interfaces';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * Records one observation per finished HTTP request: total, duration, method
 * and status code.
 *
 * ── Why an interceptor rather than middleware ──
 * An interceptor runs inside Nest's request pipeline, so it can read the
 * resolved CONTROLLER + HANDLER for a request. That is what lets us label with
 * a route TEMPLATE (`/v1/orders/:id`) instead of the raw URL (`/v1/orders/
 * 01J8XA…`). Raw URLs as a label would mint a new time series per order id and
 * eventually exhaust memory in both this process and Prometheus — the single
 * most common way a metrics endpoint takes down the service it observes.
 *
 * ── Why `tap` with both callbacks plus finalize semantics ──
 * The observation must happen exactly once whether the handler returned a value
 * or threw. `tap({ next, error })` covers both, and because the exception
 * filter has not run yet on the error path we read the status from the thrown
 * exception when the response hasn't been written.
 *
 * Non-HTTP contexts (the `ws` realtime gateway) are skipped: they have no
 * method/status to record, and forcing them into HTTP labels would be noise.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(
    private readonly metrics: MetricsService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http: HttpArgumentsHost = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const method = req.method;
    const route = this.resolveRoute(context, req);

    this.metrics.startHttpRequest(method);
    const startedAt = process.hrtime.bigint();

    const finish = (status: number) => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.metrics.observeHttpRequest(method, route, status, durationSeconds);
    };

    return next.handle().pipe(
      tap({
        next: () => finish(res.statusCode),
        error: (err: unknown) => finish(statusFromError(err, res)),
      }),
    );
  }

  /**
   * Build a low-cardinality route label.
   *
   * Express populates `req.route.path` with the matched TEMPLATE (with `:params`
   * intact) once routing has resolved, which is the ideal label. It is absent
   * for requests that never matched a route (a 404), where we deliberately
   * collapse to a single `unmatched` series rather than emitting the attacker-
   * or typo-controlled URL — an unmatched path is unbounded by definition.
   */
  private resolveRoute(context: ExecutionContext, req: Request): string {
    const routePath = (req as Request & { route?: { path?: string } }).route
      ?.path;
    if (typeof routePath === 'string' && routePath.length > 0) {
      // `baseUrl` carries any prefix the router was mounted under, so a
      // globally-prefixed app still yields the full template.
      const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
      const full = `${base}${routePath}`;
      return full.length > 0 ? full : '/';
    }

    // Fall back to the handler identity, which is still bounded by the number of
    // controllers in the app. `unmatched` is the last resort for a true 404.
    const controller = context.getClass?.()?.name;
    const handler = context.getHandler?.()?.name;
    if (controller && handler) return `${controller}.${handler}`;
    return 'unmatched';
  }
}

/**
 * Derive a status code on the error path. Nest's exception filter has not run
 * yet, so `res.statusCode` is often still the default 200 — prefer the status
 * carried by the exception itself, and fall back to 500 for a non-HTTP error.
 */
function statusFromError(err: unknown, res: Response): number {
  const status = (
    err as { status?: unknown; getStatus?: () => number }
  )?.getStatus?.();
  if (typeof status === 'number') return status;

  const raw = (err as { status?: unknown })?.status;
  if (typeof raw === 'number') return raw;

  // The response was already written (e.g. an error after streaming started).
  if (res.headersSent && res.statusCode >= 400) return res.statusCode;
  return 500;
}
