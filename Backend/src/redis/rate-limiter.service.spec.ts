// Unit tests for FixedWindowRateLimiter — the generic Redis fixed-window limiter.
// Backed by the same in-memory RedisService double used across the auth specs
// (a Map plus TTL bookkeeping). TTLs are tracked but not auto-expired, so the
// "window resets on expiry" case is driven explicitly by clearing the key —
// exactly how the OtpService spec models Redis reaping.

import { FixedWindowRateLimiter } from './rate-limiter.service';
import { RedisKeys } from './redis.keys';

/**
 * Minimal in-memory RedisService stand-in exposing just the primitives the
 * limiter uses: incr, expire, ttl, get. `store`/`ttls` are inspected in tests.
 */
function makeRedisMock() {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    incr: jest.fn(async (key: string) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
    expire: jest.fn(async (key: string, ttl: number) => {
      if (!store.has(key)) return false;
      ttls.set(key, ttl);
      return true;
    }),
    ttl: jest.fn(async (key: string) => ttls.get(key) ?? -2),
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    // Drive expiry: drop the key and its TTL, as Redis would at window end.
    expireNow: (key: string) => {
      store.delete(key);
      ttls.delete(key);
    },
  };
}

function build() {
  const redis = makeRedisMock();
  const limiter = new FixedWindowRateLimiter(redis as never);
  return { redis, limiter };
}

const LIMIT = 5;
const WINDOW = 3600;

describe('FixedWindowRateLimiter', () => {
  describe('consume()', () => {
    it('first request: allowed, counts one hit and initializes the TTL', async () => {
      const { redis, limiter } = build();
      const key = RedisKeys.rateLogin('1.2.3.4');

      const res = await limiter.consume(key, LIMIT, WINDOW);

      expect(res).toEqual({
        allowed: true,
        limit: LIMIT,
        current: 1,
        remaining: LIMIT - 1,
        retryAfter: 0,
      });
      // TTL is armed exactly once, on the first hit.
      expect(redis.expire).toHaveBeenCalledTimes(1);
      expect(redis.expire).toHaveBeenCalledWith(key, WINDOW);
      expect(redis.ttls.get(key)).toBe(WINDOW);
    });

    it('increments across hits without re-arming the TTL', async () => {
      const { redis, limiter } = build();
      const key = RedisKeys.rateLogin('1.2.3.4');

      await limiter.consume(key, LIMIT, WINDOW); // 1
      const second = await limiter.consume(key, LIMIT, WINDOW); // 2

      expect(second.current).toBe(2);
      expect(second.remaining).toBe(LIMIT - 2);
      expect(second.allowed).toBe(true);
      // EXPIRE only on the first hit — subsequent hits must not extend the window.
      expect(redis.expire).toHaveBeenCalledTimes(1);
    });

    it('allows exactly up to the limit, then blocks the next hit', async () => {
      const { limiter } = build();
      const key = RedisKeys.rateOtpRequest('+998901112233');

      for (let i = 1; i <= LIMIT; i++) {
        const res = await limiter.consume(key, LIMIT, WINDOW);
        expect(res.allowed).toBe(true);
        expect(res.current).toBe(i);
      }
      // The (LIMIT + 1)th hit trips the ceiling.
      const blocked = await limiter.consume(key, LIMIT, WINDOW);
      expect(blocked.allowed).toBe(false);
      expect(blocked.current).toBe(LIMIT + 1);
      expect(blocked.remaining).toBe(0);
    });

    it('reports retryAfter (remaining TTL) once the limit is exceeded', async () => {
      const { redis, limiter } = build();
      const key = RedisKeys.rateSms('+998901112233');

      for (let i = 0; i < LIMIT; i++) await limiter.consume(key, LIMIT, WINDOW);
      // Simulate 100s of the window having elapsed.
      redis.ttls.set(key, WINDOW - 100);

      const blocked = await limiter.consume(key, LIMIT, WINDOW);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfter).toBe(WINDOW - 100);
    });

    it('re-arms a missing TTL defensively (INCR-without-EXPIRE crash recovery)', async () => {
      const { redis, limiter } = build();
      const key = RedisKeys.rateRefresh('usr_1');
      // Simulate a counter that exists with no TTL (a prior crash between the
      // INCR and EXPIRE of the first hit).
      redis.store.set(key, 1);
      // ttls has no entry → ttl() returns -2 (no expiry).

      await limiter.consume(key, LIMIT, WINDOW); // current becomes 2
      expect(redis.ttls.get(key)).toBe(WINDOW); // TTL re-armed
    });

    it('expiration resets the counter: a new window starts from 1', async () => {
      const { redis, limiter } = build();
      const key = RedisKeys.rateLogin('1.2.3.4');

      for (let i = 0; i < LIMIT + 1; i++) await limiter.consume(key, LIMIT, WINDOW);
      expect((await limiter.consume(key, LIMIT, WINDOW)).allowed).toBe(false);

      // Redis evicts the key at window end (TTL is the only reset mechanism).
      redis.expireNow(key);

      const fresh = await limiter.consume(key, LIMIT, WINDOW);
      expect(fresh.current).toBe(1);
      expect(fresh.allowed).toBe(true);
      expect(redis.ttls.get(key)).toBe(WINDOW); // window re-armed
    });
  });

  describe('check() / remaining() / retryAfter()', () => {
    it('check() reports the window without counting a hit', async () => {
      const { redis, limiter } = build();
      const key = RedisKeys.rateLogin('1.2.3.4');
      await limiter.consume(key, LIMIT, WINDOW); // current = 1

      const view = await limiter.check(key, LIMIT);
      expect(view.current).toBe(1);
      expect(view.remaining).toBe(LIMIT - 1);
      // No extra INCR was issued by check().
      expect(redis.incr).toHaveBeenCalledTimes(1);
    });

    it('check() on an untouched key reports a full budget', async () => {
      const { limiter } = build();
      const view = await limiter.check(RedisKeys.rateLogin('9.9.9.9'), LIMIT);
      expect(view).toEqual({
        allowed: true,
        limit: LIMIT,
        current: 0,
        remaining: LIMIT,
        retryAfter: 0,
      });
    });

    it('remaining() never drops below 0 once exceeded', async () => {
      const { limiter } = build();
      const key = RedisKeys.rateSms('+998901112233');
      for (let i = 0; i < LIMIT + 3; i++) await limiter.consume(key, LIMIT, WINDOW);
      expect(await limiter.remaining(key, LIMIT)).toBe(0);
    });

    it('retryAfter() is 0 when there is no active window', async () => {
      const { limiter } = build();
      expect(await limiter.retryAfter(RedisKeys.rateLogin('0.0.0.0'))).toBe(0);
    });
  });
});
