import {
  ExecutionContext,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError, lastValueFrom } from 'rxjs';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import type { MetricsService } from './metrics.service';

/** A MetricsService double recording only what the interceptor calls. */
function metricsDouble() {
  return {
    startHttpRequest: jest.fn(),
    observeHttpRequest: jest.fn(),
  } as unknown as MetricsService & {
    startHttpRequest: jest.Mock;
    observeHttpRequest: jest.Mock;
  };
}

/** Minimal ExecutionContext for an HTTP request. */
function httpContext(
  req: Record<string, unknown>,
  res: Record<string, unknown> = { statusCode: 200 },
  type: 'http' | 'ws' = 'http',
): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getClass: () => ({ name: 'OrdersController' }),
    getHandler: () => ({ name: 'findOne' }),
  } as unknown as ExecutionContext;
}

function build() {
  const metrics = metricsDouble();
  return {
    metrics,
    interceptor: new HttpMetricsInterceptor(metrics, new Reflector()),
  };
}

describe('HttpMetricsInterceptor', () => {
  it('records method, route template and status for a successful request', async () => {
    const { metrics, interceptor } = build();
    const ctx = httpContext(
      { method: 'GET', route: { path: '/v1/orders/:id' }, baseUrl: '' },
      { statusCode: 200 },
    );

    await lastValueFrom(
      interceptor.intercept(ctx, { handle: () => of({ ok: true }) }),
    );

    expect(metrics.startHttpRequest).toHaveBeenCalledWith('GET');
    const [method, route, status, duration] =
      metrics.observeHttpRequest.mock.calls[0];
    expect(method).toBe('GET');
    // The TEMPLATE, not the concrete URL — this is the cardinality guarantee.
    expect(route).toBe('/v1/orders/:id');
    expect(status).toBe(200);
    expect(typeof duration).toBe('number');
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it('prefixes the route with baseUrl when the router is mounted under a prefix', async () => {
    const { metrics, interceptor } = build();
    const ctx = httpContext({
      method: 'POST',
      route: { path: '/:id/status' },
      baseUrl: '/v1/orders',
    });

    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(null) }));

    expect(metrics.observeHttpRequest.mock.calls[0][1]).toBe(
      '/v1/orders/:id/status',
    );
  });

  it('records the exception status on the error path and still releases in-flight', async () => {
    const { metrics, interceptor } = build();
    const ctx = httpContext(
      { method: 'GET', route: { path: '/v1/orders/:id' } },
      // The exception filter has not run yet, so the response still says 200.
      { statusCode: 200 },
    );

    await expect(
      lastValueFrom(
        interceptor.intercept(ctx, {
          handle: () => throwError(() => new NotFoundException()),
        }),
      ),
    ).rejects.toBeInstanceOf(HttpException);

    // 404 from the exception, NOT the stale 200 on the response object.
    expect(metrics.observeHttpRequest.mock.calls[0][2]).toBe(404);
  });

  it('falls back to 500 for a non-HTTP error', async () => {
    const { metrics, interceptor } = build();
    const ctx = httpContext({ method: 'GET', route: { path: '/v1/x' } });

    await expect(
      lastValueFrom(
        interceptor.intercept(ctx, {
          handle: () => throwError(() => new Error('boom')),
        }),
      ),
    ).rejects.toThrow('boom');

    expect(metrics.observeHttpRequest.mock.calls[0][2]).toBe(500);
  });

  it('collapses an unmatched path to a single series instead of echoing the URL', async () => {
    const { metrics, interceptor } = build();
    // No `route` — a 404 that never matched a handler. Using the raw URL here
    // would let anyone mint unbounded series by requesting random paths.
    const ctx = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/random/9d2f/attack' }),
        getResponse: () => ({ statusCode: 404 }),
      }),
      getClass: () => undefined,
      getHandler: () => undefined,
    } as unknown as ExecutionContext;

    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(null) }));

    expect(metrics.observeHttpRequest.mock.calls[0][1]).toBe('unmatched');
  });

  it('ignores non-HTTP contexts such as the websocket gateway', async () => {
    const { metrics, interceptor } = build();
    const ctx = httpContext({ method: 'GET' }, { statusCode: 200 }, 'ws');

    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(null) }));

    expect(metrics.startHttpRequest).not.toHaveBeenCalled();
    expect(metrics.observeHttpRequest).not.toHaveBeenCalled();
  });

  it('records exactly one observation per request', async () => {
    const { metrics, interceptor } = build();
    const ctx = httpContext({ method: 'GET', route: { path: '/v1/x' } });

    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(1) }));

    expect(metrics.observeHttpRequest).toHaveBeenCalledTimes(1);
  });
});
