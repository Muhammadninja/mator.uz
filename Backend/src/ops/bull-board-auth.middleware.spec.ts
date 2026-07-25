import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { BullBoardAuthMiddleware } from './bull-board-auth.middleware';

function configWith(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** Response double capturing the status/headers the middleware sets. */
function responseDouble() {
  const res = {
    statusCode: undefined as number | undefined,
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

function requestWith(authorization?: string): Request {
  return {
    headers: authorization ? { authorization } : {},
    ip: '10.0.0.1',
  } as unknown as Request;
}

/** Run the middleware and report whether it called next(). */
function run(middleware: BullBoardAuthMiddleware, req: Request) {
  const res = responseDouble();
  const next = jest.fn() as unknown as NextFunction;
  middleware.use(req, res as unknown as Response, next);
  return { res, passed: (next as jest.Mock).mock.calls.length === 1 };
}

const CREDS = { BULL_BOARD_USER: 'ops', BULL_BOARD_PASSWORD: 's3cret' };

describe('BullBoardAuthMiddleware', () => {
  it('allows a request with correct credentials', () => {
    const middleware = new BullBoardAuthMiddleware(configWith(CREDS));

    const { passed, res } = run(
      middleware,
      requestWith(basic('ops', 's3cret')),
    );

    expect(passed).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  it('rejects a wrong password', () => {
    const middleware = new BullBoardAuthMiddleware(configWith(CREDS));

    const { passed, res } = run(middleware, requestWith(basic('ops', 'wrong')));

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong username', () => {
    const middleware = new BullBoardAuthMiddleware(configWith(CREDS));

    const { passed } = run(middleware, requestWith(basic('mallory', 's3cret')));

    expect(passed).toBe(false);
  });

  it('rejects a request with no Authorization header', () => {
    const middleware = new BullBoardAuthMiddleware(configWith(CREDS));

    const { passed, res } = run(middleware, requestWith());

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
    // The challenge is what makes a browser show its login prompt.
    expect(res.headers['WWW-Authenticate']).toContain('Basic');
  });

  it('rejects a non-Basic scheme', () => {
    const middleware = new BullBoardAuthMiddleware(configWith(CREDS));

    const { passed } = run(middleware, requestWith('Bearer some.jwt.token'));

    expect(passed).toBe(false);
  });

  it('rejects malformed base64 credentials with no colon', () => {
    const middleware = new BullBoardAuthMiddleware(configWith(CREDS));
    const encoded = Buffer.from('nocolonhere').toString('base64');

    const { passed } = run(middleware, requestWith(`Basic ${encoded}`));

    expect(passed).toBe(false);
  });

  it('fails closed when no credentials are configured', () => {
    // The critical case: an enabled dashboard with unset env vars must never be
    // world-readable.
    const middleware = new BullBoardAuthMiddleware(configWith({}));

    const { passed, res } = run(middleware, requestWith(basic('', '')));

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('fails closed when only the username is configured', () => {
    const middleware = new BullBoardAuthMiddleware(
      configWith({ BULL_BOARD_USER: 'ops' }),
    );

    const { passed } = run(middleware, requestWith(basic('ops', '')));

    expect(passed).toBe(false);
  });

  it('accepts a password containing colons', () => {
    // Splitting on the first colon only — a regression here would lock out any
    // operator whose generated password contains ':'.
    const middleware = new BullBoardAuthMiddleware(
      configWith({ BULL_BOARD_USER: 'ops', BULL_BOARD_PASSWORD: 'a:b:c' }),
    );

    const { passed } = run(middleware, requestWith(basic('ops', 'a:b:c')));

    expect(passed).toBe(true);
  });
});
