import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Outcome of a rate-limit decision. Purely structured data — the limiter never
 * throws an HTTP exception; the caller (controller/service) decides what to do
 * with a `!allowed` result (e.g. throw 429). Strongly typed so every field is
 * available to build a `Retry-After` header or a user-facing message.
 */
export interface RateLimitResult {
  /** False once the counter has passed `limit` within the window. */
  allowed: boolean;
  /** The window's ceiling (echoed back so callers can build messages/headers). */
  limit: number;
  /** Hits recorded so far in the current window (>= 1 after a consume). */
  current: number;
  /** Hits still allowed before the limit trips; 0 once exceeded. */
  remaining: number;
  /**
   * Seconds until the window resets and the subject may proceed. Derived from
   * the key's live TTL, so it shrinks as the window elapses. 0 when the limit
   * is not exceeded.
   */
  retryAfter: number;
}

/**
 * The rate-limiting contract every caller depends on — deliberately algorithm
 * -agnostic. Callers inject the {@link RATE_LIMITER} token typed as this
 * interface, never a concrete class, so a different algorithm can be swapped in
 * later (sliding window, token bucket) without touching a single call site.
 *
 * The infrastructure never throws HTTP exceptions: it returns a
 * {@link RateLimitResult} and the caller decides what to do with `!allowed`.
 */
export interface RateLimiter {
  /** Count one hit against `key`; report whether it is allowed. */
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Read the current window WITHOUT counting a hit. */
  check(key: string, limit: number): Promise<RateLimitResult>;
  /** Hits still allowed for `key` under `limit` before it trips. */
  remaining(key: string, limit: number): Promise<number>;
  /** Seconds until the window for `key` resets (0 when no active window). */
  retryAfter(key: string): Promise<number>;
}

/**
 * DI token for the active {@link RateLimiter} implementation. Inject with
 * `@Inject(RATE_LIMITER)` and type the field as `RateLimiter`, so consumers
 * bind to the abstraction. Today it resolves to {@link FixedWindowRateLimiter};
 * pointing it at another implementation later requires no consumer changes.
 */
export const RATE_LIMITER = Symbol('RATE_LIMITER');

/**
 * The single, generic place for Redis-backed rate limiting. Every limiter (OTP
 * request/verify, login, refresh, SMS, password reset, API abuse) goes through
 * the {@link RateLimiter} contract — no Redis counter logic is duplicated
 * elsewhere.
 *
 * This is the **fixed-window** implementation: a counter per `(action, subject)`
 * key. `INCR` bumps the counter and, on the first hit of a window
 * (`count === 1`), `EXPIRE` arms the window's TTL. When the key later expires,
 * the next `INCR` starts a fresh window from 1 — Redis TTL is the only reset
 * mechanism (no cron, no cleanup).
 *
 * Atomic primitives only: INCR + EXPIRE. No SCAN, no KEYS, no Lua. The tiny
 * window between INCR and EXPIRE (first hit only) is harmless: at worst a key
 * without a TTL is re-INCR'd and gets its TTL on the very next call, and the
 * check below re-arms a missing TTL defensively. (A future sliding-window /
 * token-bucket implementation of {@link RateLimiter} may legitimately need
 * richer primitives — that constraint is specific to this fixed-window class.)
 */
@Injectable()
export class FixedWindowRateLimiter implements RateLimiter {
  constructor(private readonly redis: RedisService) {}

  /**
   * Count one hit against `key` and report whether it is allowed. Callers build
   * the key from {@link RedisKeys} (e.g. `RedisKeys.rateOtpRequest(phone)`), so
   * key formatting never leaks into call sites.
   *
   * @param key           fully-qualified Redis key (from RedisKeys)
   * @param limit         max hits permitted within the window
   * @param windowSeconds window length; TTL set on the first hit
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const current = await this.redis.incr(key);
    if (current === 1) {
      // First hit of a new window — arm the TTL so the counter self-expires.
      await this.redis.expire(key, windowSeconds);
    } else {
      // Defensive: if a prior process crashed between INCR and EXPIRE, the key
      // could be counting with no TTL and would live forever. Re-arm it.
      const ttl = await this.redis.ttl(key);
      if (ttl < 0) await this.redis.expire(key, windowSeconds);
    }
    return this.buildResult(key, current, limit);
  }

  /**
   * Read-only view of the current window WITHOUT counting a hit. Use to reflect
   * remaining budget (e.g. in a pre-flight check) or decide before consuming.
   */
  async check(key: string, limit: number): Promise<RateLimitResult> {
    const raw = await this.redis.get<number | string>(key);
    const current = raw === null ? 0 : Number(raw);
    return this.buildResult(key, current, limit);
  }

  /** Hits still allowed for `key` under `limit` before it trips (never below 0). */
  async remaining(key: string, limit: number): Promise<number> {
    const { remaining } = await this.check(key, limit);
    return remaining;
  }

  /**
   * Seconds until the window for `key` resets. Reads the key's live TTL; returns
   * 0 when the key is absent or carries no expiry (nothing to wait for).
   */
  async retryAfter(key: string): Promise<number> {
    const ttl = await this.redis.ttl(key);
    return ttl > 0 ? ttl : 0;
  }

  /**
   * Assemble the typed result. `retryAfter` is only meaningful once the limit is
   * exceeded, so the (one extra) TTL read is skipped while the subject is still
   * within budget.
   */
  private async buildResult(key: string, current: number, limit: number): Promise<RateLimitResult> {
    const allowed = current <= limit;
    const remaining = Math.max(0, limit - current);
    const retryAfter = allowed ? 0 : await this.retryAfter(key);
    return { allowed, limit, current, remaining, retryAfter };
  }
}
