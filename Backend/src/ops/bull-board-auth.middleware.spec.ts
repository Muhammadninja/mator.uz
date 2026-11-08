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
async function run(middleware: BullBoardAuthMiddleware, req: Request) {
  const res = responseDouble();
  const next = jest.fn() as unknown as NextFunction;
  await middleware.use(req, res as unknown as Response, next);
  return { res, passed: (next as jest.Mock).mock.calls.length === 1 };
}

/** FixedWindowRateLimiter's arithmetic, in memory. */
function memoryLimiter() {
  const hits = new Map<string, number>();
  const result = (key: string, limit: number) => {
    const current = hits.get(key) ?? 0;
    return {
      allowed: current <= limit,
      limit,
      current,
      remaining: Math.max(0, limit - current),
      retryAfter: current <= limit ? 0 : 900,
    };
  };
  return {
    consume: (key: string, limit: number) => {
      hits.set(key, (hits.get(key) ?? 0) + 1);
      return Promise.resolve(result(key, limit));
    },
    check: (key: string, limit: number) => Promise.resolve(result(key, limit)),
    hits,
  } as never;
}

const CREDS = { BULL_BOARD_USER: 'ops', BULL_BOARD_PASSWORD: 's3cret' };

const board = (
  values: Record<string, string> = CREDS,
  limiter: never = memoryLimiter(),
) => new BullBoardAuthMiddleware(configWith(values), limiter);

describe('BullBoardAuthMiddleware', () => {
  it('allows a request with correct credentials', async () => {
    const middleware = board();

    const { passed, res } = await run(
      middleware,
      requestWith(basic('ops', 's3cret')),
    );

    expect(passed).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  it('rejects a wrong password', async () => {
    const middleware = board();

    const { passed, res } = await run(middleware, requestWith(basic('ops', 'wrong')));

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong username', async () => {
    const middleware = board();

    const { passed } = await run(middleware, requestWith(basic('mallory', 's3cret')));

    expect(passed).toBe(false);
  });

  it('rejects a request with no Authorization header', async () => {
    const middleware = board();

    const { passed, res } = await run(middleware, requestWith());

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
    // The challenge is what makes a browser show its login prompt.
    expect(res.headers['WWW-Authenticate']).toContain('Basic');
  });

  it('rejects a non-Basic scheme', async () => {
    const middleware = board();

    const { passed } = await run(middleware, requestWith('Bearer some.jwt.token'));

    expect(passed).toBe(false);
  });

  it('rejects malformed base64 credentials with no colon', async () => {
    const middleware = board();
    const encoded = Buffer.from('nocolonhere').toString('base64');

    const { passed } = await run(middleware, requestWith(`Basic ${encoded}`));

    expect(passed).toBe(false);
  });

  it('fails closed when no credentials are configured', async () => {
    // The critical case: an enabled dashboard with unset env vars must never be
    // world-readable.
    const middleware = board({});

    const { passed, res } = await run(middleware, requestWith(basic('', '')));

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('fails closed when only the username is configured', async () => {
    const middleware = board({ BULL_BOARD_USER: 'ops' });

    const { passed } = await run(middleware, requestWith(basic('ops', '')));

    expect(passed).toBe(false);
  });

  it('accepts a password containing colons', async () => {
    // Splitting on the first colon only — a regression here would lock out any
    // operator whose generated password contains ':'.
    const middleware = board({ BULL_BOARD_USER: 'ops', BULL_BOARD_PASSWORD: 'a:b:c' });

    const { passed } = await run(middleware, requestWith(basic('ops', 'a:b:c')));

    expect(passed).toBe(true);
  });

  describe('failed-login limit', () => {
    const fromSocket = (authorization: string, peer: string, ip: string) =>
      ({
        headers: { authorization },
        ip,
        socket: { remoteAddress: peer },
      }) as unknown as Request;
    const wrong = basic('ops', 'wrong');
    const right = basic('ops', 's3cret');

    it('throttles repeated wrong credentials', async () => {
      const middleware = board();
      for (let i = 0; i < 10; i += 1) {
        const { res } = await run(middleware, fromSocket(wrong, '198.51.100.7', 'x'));
        expect(res.statusCode).toBe(401);
      }
      const { res } = await run(middleware, fromSocket(wrong, '198.51.100.7', 'x'));
      expect(res.statusCode).toBe(429);
      expect(res.headers['Retry-After']).toBe('900');
    });

    it('refuses even correct credentials once locked out, so a guess cannot be confirmed', async () => {
      const middleware = board();
      for (let i = 0; i < 11; i += 1) {
        await run(middleware, fromSocket(wrong, '198.51.100.7', 'x'));
      }
      const { passed, res } = await run(middleware, fromSocket(right, '198.51.100.7', 'x'));
      expect(passed).toBe(false);
      expect(res.statusCode).toBe(429);
    });

    it('does not let a forged X-Forwarded-For reset a client connecting directly', async () => {
      // With trust proxy 1, req.ip follows whatever header a direct client sends.
      const middleware = board();
      for (let i = 0; i < 11; i += 1) {
        await run(middleware, fromSocket(wrong, '198.51.100.7', `10.9.9.${i}`));
      }
      const { res } = await run(middleware, fromSocket(wrong, '198.51.100.7', '10.1.1.1'));
      expect(res.statusCode).toBe(429);
    });

    it('counts clients behind the local proxy separately, by the address it reports', async () => {
      const middleware = board();
      for (let i = 0; i < 11; i += 1) {
        await run(middleware, fromSocket(wrong, '127.0.0.1', '203.0.113.1'));
      }
      const { passed } = await run(middleware, fromSocket(right, '127.0.0.1', '203.0.113.2'));
      expect(passed).toBe(true);
    });

    it('does not count a request with no credentials or a valid login', async () => {
      const limiter = memoryLimiter() as unknown as { hits: Map<string, number> };
      const middleware = board(CREDS, limiter as never);
      await run(middleware, requestWith());
      await run(middleware, requestWith(right));
      expect(limiter.hits.size).toBe(0);
    });

    it('fails closed with a 503 when the counter cannot be reached', async () => {
      const middleware = board(CREDS, {
        check: () => Promise.reject(new Error('down')),
        consume: () => Promise.reject(new Error('down')),
      } as never);
      const { passed, res } = await run(middleware, requestWith(right));
      expect(passed).toBe(false);
      expect(res.statusCode).toBe(503);
    });
  });
});
