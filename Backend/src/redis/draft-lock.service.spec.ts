// Unit tests for DraftLock — the short-lived mutex behind the draft/preview
// guards. The contract under test is deliberately narrow, because the lock is an
// optimisation and never the source of truth:
//   • mutual exclusion via SET NX EX (a second acquire loses)
//   • stale-safety: the TTL is always armed, so a crashed holder self-heals
//   • fenced release: a holder never deletes a lock it no longer owns
//   • fail-OPEN: a Redis outage must not block the flow (the DB still guards)

import { DraftLock } from './draft-lock.service';
import type { RedisService } from './redis.service';

/** A tiny in-memory Redis double covering just SET NX EX and EVAL(compare-and-del). */
function makeRedis() {
  const store = new Map<string, string>();
  const setCalls: Array<{ key: string; ttl: number; nx: boolean }> = [];

  const client = {
    set: jest.fn(
      async (key: string, val: string, ex: string, ttl: number, nx?: string) => {
        setCalls.push({ key, ttl, nx: nx === 'NX' });
        if (nx === 'NX' && store.has(key)) return null; // NX: already held
        store.set(key, val);
        return 'OK';
      },
    ),
    // Mirrors the fenced-release Lua: DEL only when the token still matches.
    eval: jest.fn(async (_script: string, _n: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };

  const redis = { getClient: () => client } as unknown as RedisService;
  return { redis, client, store, setCalls };
}

function makeLock(redis: RedisService): DraftLock {
  return new DraftLock(redis);
}

describe('DraftLock', () => {
  describe('mutual exclusion', () => {
    it('grants the first acquire and refuses the second while held', async () => {
      const { redis } = makeRedis();
      const lock = makeLock(redis);

      const first = await lock.acquire('lock:a');
      const second = await lock.acquire('lock:a');

      expect(first).not.toBeNull();
      expect(second).toBeNull(); // the duplicate tap
    });

    it('lets the next caller in after the holder releases', async () => {
      const { redis } = makeRedis();
      const lock = makeLock(redis);

      const first = await lock.acquire('lock:a');
      await first!.release();
      const second = await lock.acquire('lock:a');

      expect(second).not.toBeNull();
    });

    it('scopes locks per key — different drafts never contend', async () => {
      const { redis } = makeRedis();
      const lock = makeLock(redis);

      expect(await lock.acquire('lock:draft:clone:d1')).not.toBeNull();
      expect(await lock.acquire('lock:draft:clone:d2')).not.toBeNull();
    });
  });

  describe('withLock', () => {
    it('runs the body under the lock and releases it afterwards', async () => {
      const { redis, store } = makeRedis();
      const lock = makeLock(redis);

      const result = await lock.withLock('lock:a', async () => {
        expect(store.has('lock:a')).toBe(true); // held during the body
        return 'done';
      });

      expect(result).toBe('done');
      expect(store.has('lock:a')).toBe(false); // released after
    });

    it('returns undefined WITHOUT running the body when the lock is held', async () => {
      const { redis } = makeRedis();
      const lock = makeLock(redis);
      await lock.acquire('lock:a'); // someone else holds it

      const body = jest.fn().mockResolvedValue('should not run');
      const result = await lock.withLock('lock:a', body);

      expect(body).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('releases the lock even when the body throws (no wedged key)', async () => {
      const { redis, store } = makeRedis();
      const lock = makeLock(redis);

      await expect(
        lock.withLock('lock:a', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(store.has('lock:a')).toBe(false);
      // …and the next caller can proceed immediately.
      expect(await lock.acquire('lock:a')).not.toBeNull();
    });
  });

  describe('stale-lock / retry safety', () => {
    it('always arms a TTL, so a crashed holder cannot wedge the key forever', async () => {
      const { redis, setCalls } = makeRedis();
      const lock = makeLock(redis);

      await lock.acquire('lock:a');

      expect(setCalls[0].nx).toBe(true);
      expect(setCalls[0].ttl).toBe(DraftLock.DEFAULT_TTL_SECONDS);
      expect(setCalls[0].ttl).toBeGreaterThan(0);
    });

    it('honours a caller-supplied TTL', async () => {
      const { redis, setCalls } = makeRedis();
      const lock = makeLock(redis);

      await lock.acquire('lock:a', 5);

      expect(setCalls[0].ttl).toBe(5);
    });

    // TTL sizing is a correctness property, not a tuning knob: a lock held
    // longer than its critical section's worst case is a window where a
    // crashed holder falsely blocks a legitimate retry (see the doc comments on
    // both constants). These tests pin the two named TTLs to the ordering that
    // reasoning depends on, so a future edit that widens ENQUEUE_TTL_SECONDS
    // toward DEFAULT_TTL_SECONDS "to be safe" fails loudly instead of silently
    // reopening that window.
    it('sizes ENQUEUE_TTL_SECONDS well below DEFAULT_TTL_SECONDS', () => {
      // The enqueue lock wraps pure Redis/BullMQ calls (no Cloudinary, no
      // Telegram), unlike clone/preview/reopen which wrap a transaction plus one
      // external call — it must not share their longer allowance.
      expect(DraftLock.ENQUEUE_TTL_SECONDS).toBeLessThan(
        DraftLock.DEFAULT_TTL_SECONDS,
      );
      expect(DraftLock.ENQUEUE_TTL_SECONDS).toBeGreaterThan(0);
    });

    it('both TTLs are comfortably above a sub-second critical section', () => {
      // Not "as short as possible" either — must survive a slow tick/GC pause
      // without manufacturing a false "busy" for a holder that is still
      // legitimately working. 1s is a generous floor for either lock type.
      expect(DraftLock.ENQUEUE_TTL_SECONDS).toBeGreaterThanOrEqual(1);
      expect(DraftLock.DEFAULT_TTL_SECONDS).toBeGreaterThanOrEqual(1);
    });

    it('lets a retry proceed once a stale lock has expired', async () => {
      const { redis, store } = makeRedis();
      const lock = makeLock(redis);

      await lock.acquire('lock:a'); // holder then "crashes" — never releases
      expect(await lock.acquire('lock:a')).toBeNull();

      store.delete('lock:a'); // Redis expires the key via its TTL

      expect(await lock.acquire('lock:a')).not.toBeNull(); // retry succeeds
    });

    it('fences release: a stale holder cannot delete the new holder’s lock', async () => {
      const { redis, store } = makeRedis();
      const lock = makeLock(redis);

      const stale = await lock.acquire('lock:a');
      store.delete('lock:a'); // its TTL elapsed
      const fresh = await lock.acquire('lock:a'); // a new holder took over
      const freshToken = store.get('lock:a');

      await stale!.release(); // the slow, expired holder finally releases

      // The new holder's lock survives — the token did not match.
      expect(store.get('lock:a')).toBe(freshToken);
      expect(fresh).not.toBeNull();
      // And releasing the real holder still works.
      await fresh!.release();
      expect(store.has('lock:a')).toBe(false);
    });

    it('never throws when release fails — the TTL is the real guarantee', async () => {
      const { redis, client } = makeRedis();
      const lock = makeLock(redis);
      const handle = await lock.acquire('lock:a');
      client.eval.mockRejectedValueOnce(new Error('redis gone'));

      await expect(handle!.release()).resolves.toBeUndefined();
    });
  });

  describe('fail-open when Redis is unavailable', () => {
    it('acquire returns a usable no-op handle instead of blocking', async () => {
      const { redis, client } = makeRedis();
      client.set.mockRejectedValue(new Error('ECONNREFUSED'));
      const lock = makeLock(redis);

      const handle = await lock.acquire('lock:a');

      // NOT null: a cache outage must never stop a seller from publishing —
      // the DB guard downstream still rejects any genuine duplicate.
      expect(handle).not.toBeNull();
      await expect(handle!.release()).resolves.toBeUndefined();
    });

    it('withLock still runs the body when Redis is down', async () => {
      const { redis, client } = makeRedis();
      client.set.mockRejectedValue(new Error('ECONNREFUSED'));
      const lock = makeLock(redis);

      const body = jest.fn().mockResolvedValue('ran');
      await expect(lock.withLock('lock:a', body)).resolves.toBe('ran');
      expect(body).toHaveBeenCalledTimes(1);
    });
  });
});
