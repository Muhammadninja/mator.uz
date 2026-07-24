// Unit tests for CacheService — the generic read-through cache. Backed by an
// in-memory RedisService double (a Map with recorded TTLs), matching the style
// used across the OTP / rate-limiter specs. The fail-open behaviour is driven by
// making the double's get/setEx reject.

import { CacheService } from './cache.service';

/**
 * Minimal in-memory RedisService stand-in. `get` mirrors the real service's
 * JSON round-trip (values are stored already-parsed). `store`/`ttls` are
 * inspected in tests. Individual methods are overridden per-test to simulate
 * Redis failures.
 */
function makeRedisMock() {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    setEx: jest.fn(async (key: string, ttl: number, value: unknown) => {
      store.set(key, JSON.parse(JSON.stringify(value)));
      ttls.set(key, ttl);
      return 'OK' as const;
    }),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

function build() {
  const redis = makeRedisMock();
  const cache = new CacheService(redis as never);
  // Silence the fail-open warn logs in the failure tests.
  jest.spyOn((cache as any).logger, 'warn').mockImplementation(() => undefined);
  return { redis, cache };
}

const KEY = 'cache:reference:makes';
const TTL = 86400;

describe('CacheService', () => {
  describe('get / set / delete', () => {
    it('set writes with the given TTL; get reads it back', async () => {
      const { redis, cache } = build();
      await cache.set(KEY, { items: [], total: 0 }, TTL);
      expect(redis.setEx).toHaveBeenCalledWith(KEY, TTL, { items: [], total: 0 });
      expect(redis.ttls.get(KEY)).toBe(TTL);
      await expect(cache.get(KEY)).resolves.toEqual({ items: [], total: 0 });
    });

    it('get returns null on a miss', async () => {
      const { cache } = build();
      await expect(cache.get('absent')).resolves.toBeNull();
    });

    it('delete removes the entry', async () => {
      const { redis, cache } = build();
      await cache.set(KEY, 1, TTL);
      await cache.delete(KEY);
      expect(redis.store.has(KEY)).toBe(false);
    });
  });

  describe('remember()', () => {
    it('cache MISS: runs the loader, caches the result with the TTL, returns it', async () => {
      const { redis, cache } = build();
      const value = { items: [{ id: 'a' }], total: 1 };
      const loader = jest.fn().mockResolvedValue(value);

      const res = await cache.remember(KEY, TTL, loader);

      expect(res).toEqual(value);
      expect(loader).toHaveBeenCalledTimes(1);
      // Result was written through with the correct TTL.
      expect(redis.setEx).toHaveBeenCalledWith(KEY, TTL, value);
      expect(redis.ttls.get(KEY)).toBe(TTL);
    });

    it('cache HIT: returns the cached value and does NOT run the loader', async () => {
      const { redis, cache } = build();
      const cached = { items: [{ id: 'cached' }], total: 1 };
      await cache.set(KEY, cached, TTL);
      redis.setEx.mockClear();
      const loader = jest.fn();

      const res = await cache.remember(KEY, TTL, loader);

      expect(res).toEqual(cached);
      expect(loader).not.toHaveBeenCalled();
      expect(redis.setEx).not.toHaveBeenCalled(); // no re-write on a hit
    });

    it('loader runs exactly once across a miss', async () => {
      const { cache } = build();
      const loader = jest.fn().mockResolvedValue('v');
      await cache.remember(KEY, TTL, loader);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('passes the TTL through to Redis unchanged', async () => {
      const { redis, cache } = build();
      await cache.remember(KEY, 123, async () => 'v');
      expect(redis.setEx).toHaveBeenCalledWith(KEY, 123, 'v');
    });

    it('loader errors are NOT swallowed (a real load failure must propagate)', async () => {
      const { cache } = build();
      const loader = jest.fn().mockRejectedValue(new Error('db down'));
      await expect(cache.remember(KEY, TTL, loader)).rejects.toThrow('db down');
    });
  });

  describe('fail-open (Redis unavailable)', () => {
    it('a failing Redis READ surfaces as a miss → loader runs, request succeeds', async () => {
      const { redis, cache } = build();
      redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const loader = jest.fn().mockResolvedValue({ items: [], total: 0 });

      const res = await cache.remember(KEY, TTL, loader);

      expect(res).toEqual({ items: [], total: 0 });
      expect(loader).toHaveBeenCalledTimes(1); // fell back to the source
    });

    it('a failing Redis WRITE is swallowed → the loaded value is still returned', async () => {
      const { redis, cache } = build();
      redis.setEx.mockRejectedValue(new Error('ECONNREFUSED'));
      const loader = jest.fn().mockResolvedValue('payload');

      await expect(cache.remember(KEY, TTL, loader)).resolves.toBe('payload');
    });

    it('get() returns null (not throw) when Redis read fails', async () => {
      const { redis, cache } = build();
      redis.get.mockRejectedValue(new Error('down'));
      await expect(cache.get(KEY)).resolves.toBeNull();
    });
  });
});
