import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { RateLimiter } from '../redis/rate-limiter.service';
import { RedisKeys } from '../redis/redis.keys';
import {
  assertRedisBacklogRoom,
  withRedisTimeout,
} from '../redis/redis.service';

/** Wrong credentials one client may send per window, before being refused. */
export const BASIC_AUTH_MAX_FAILURES = 10;
export const BASIC_AUTH_WINDOW_S = 15 * 60;
const LIMITER_TIMEOUT_MS = 2_000;

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/**
 * Who to count a failure against, in a form the sender cannot choose. The address
 * that opened the socket cannot be forged. Only when that address is this machine,
 * meaning Nginx in front of the app, is `req.ip` used: with `trust proxy 1` it is the
 * entry Nginx itself appended. A client reaching the app port directly can send any
 * X-Forwarded-For it likes, and is counted by its socket regardless.
 */
export function basicAuthClient(req: Pick<Request, 'ip' | 'socket'>): string {
  const peer = req.socket?.remoteAddress ?? '';
  const client = peer && !LOOPBACK.test(peer) ? peer : (req.ip ?? peer);
  return createHash('sha256').update(client).digest('hex').slice(0, 32);
}

/**
 * The failed-login limit for a Basic Auth page. Only wrong credentials count: a
 * browser's first request (no header) and an operator's normal page loads do not.
 *
 * Callers compare the credentials first and then ask here, so a burst of guesses is
 * counted atomically one by one. Once a client is over the limit even correct
 * credentials are refused, or the different answer would confirm a guess.
 *
 * Fails closed: both methods reject when the counter cannot be reached.
 */
export class BasicAuthThrottle {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly scope: string,
  ) {}

  /** Count a wrong attempt. Returns the seconds to wait when over the limit, else 0. */
  recordFailure(client: string): Promise<number> {
    return this.bounded(() =>
      this.limiter.consume(
        RedisKeys.rateBasicAuth(this.scope, client),
        BASIC_AUTH_MAX_FAILURES,
        BASIC_AUTH_WINDOW_S,
      ),
    );
  }

  /** Seconds this client must still wait, or 0 when it is not locked out. */
  lockedFor(client: string): Promise<number> {
    return this.bounded(() =>
      this.limiter.check(
        RedisKeys.rateBasicAuth(this.scope, client),
        BASIC_AUTH_MAX_FAILURES,
      ),
    );
  }

  private async bounded(
    run: () => Promise<{ allowed: boolean; retryAfter: number }>,
  ): Promise<number> {
    assertRedisBacklogRoom('Basic Auth limit');
    const result = await withRedisTimeout(
      run(),
      LIMITER_TIMEOUT_MS,
      'Basic Auth limit',
    );
    return result.allowed ? 0 : Math.max(result.retryAfter, 1);
  }
}

/** The answer to a locked-out client. Says nothing about the credentials. */
export function denyLockedOut(res: Response, retryAfter: number): void {
  res.setHeader('Retry-After', String(retryAfter));
  res.setHeader('Cache-Control', 'no-store');
  res.status(429).send('Too Many Requests');
}

/** The answer when the failure counter cannot be reached. */
export function denyUnavailable(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(503).send('Service Unavailable');
}
