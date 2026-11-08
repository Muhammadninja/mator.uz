/* eslint-disable @typescript-eslint/require-await -- an in-memory fake mirrors an async API */
/**
 * RedisService over a Map, for specs of the Redis-backed limits. Every command
 * yields first, so concurrent callers really interleave, while
 * each command itself stays atomic, as it is in Redis. Test-only.
 */
// A microtask, so specs running under fake timers are not held up.
const tick = () => Promise.resolve();

export function makeFakeRedis() {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  const increase = async (key: string, by: number) => {
    await tick();
    const next = ((store.get(key) as number) ?? 0) + by;
    store.set(key, next);
    return next;
  };
  return {
    store,
    ttls,
    get: jest.fn(async (key: string) => {
      await tick();
      return store.has(key) ? store.get(key) : null;
    }),
    setEx: jest.fn(async (key: string, ttl: number, value: unknown) => {
      await tick();
      store.set(key, JSON.parse(JSON.stringify(value)));
      ttls.set(key, ttl);
      return 'OK' as const;
    }),
    del: jest.fn(async (key: string) => {
      await tick();
      ttls.delete(key);
      return store.delete(key) ? 1 : 0;
    }),
    incr: jest.fn((key: string) => increase(key, 1)),
    decr: jest.fn((key: string) => increase(key, -1)),
    expire: jest.fn(async (key: string, ttl: number) => {
      await tick();
      if (!store.has(key)) return false;
      ttls.set(key, ttl);
      return true;
    }),
    ttl: jest.fn(async (key: string) => ttls.get(key) ?? -2),
  };
}
export type FakeRedis = ReturnType<typeof makeFakeRedis>;
