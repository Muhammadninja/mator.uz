// Tests for the request-id middleware: it must stamp every request, honour a
// usable inbound id, echo the id back, and make it visible downstream.

import type { NextFunction, Request, Response } from 'express';
import { getRequestId } from './request-context';
import { requestIdMiddleware } from './request-id.middleware';

function makeReq(headers: Record<string, unknown> = {}) {
  return { headers } as unknown as Request & { requestId?: string };
}

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
  } as unknown as Response & { headers: Record<string, string> };
}

describe('requestIdMiddleware', () => {
  it('generates an id when the client sends none', () => {
    const req = makeReq();
    const res = makeRes();
    let seen: string | undefined;

    requestIdMiddleware(req, res, (() => {
      seen = getRequestId();
    }) as NextFunction);

    expect(seen).toMatch(/^[0-9A-F]{6}$/);
    expect(req.requestId).toBe(seen);
    expect(res.headers['x-request-id']).toBe(seen);
  });

  it('honours a usable inbound X-Request-Id', () => {
    // Lets a correlation started upstream (Nginx, another service) continue.
    const req = makeReq({ 'x-request-id': 'upstream-42' });
    const res = makeRes();
    let seen: string | undefined;

    requestIdMiddleware(req, res, (() => {
      seen = getRequestId();
    }) as NextFunction);

    expect(seen).toBe('upstream-42');
    expect(res.headers['x-request-id']).toBe('upstream-42');
  });

  it('replaces an unusable inbound id rather than trusting it', () => {
    const req = makeReq({ 'x-request-id': '!!!' });
    const res = makeRes();
    let seen: string | undefined;

    requestIdMiddleware(req, res, (() => {
      seen = getRequestId();
    }) as NextFunction);

    expect(seen).toMatch(/^[0-9A-F]{6}$/);
  });

  it('sanitizes a hostile inbound id before it can reach a log line', () => {
    const req = makeReq({ 'x-request-id': 'ok\n[ERROR] injected' });
    const res = makeRes();
    let seen: string | undefined;

    requestIdMiddleware(req, res, (() => {
      seen = getRequestId();
    }) as NextFunction);

    expect(seen).not.toContain('\n');
    expect(seen).toBe('okERRORinjected');
  });

  it('always calls next exactly once', () => {
    const next = jest.fn();
    requestIdMiddleware(makeReq(), makeRes(), next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('gives concurrent requests distinct ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      requestIdMiddleware(makeReq(), makeRes(), (() => {
        ids.add(getRequestId()!);
      }) as NextFunction);
    }
    expect(ids.size).toBe(20);
  });
});
