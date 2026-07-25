import { DraftLock } from '../redis/draft-lock.service';

/**
 * An in-memory stand-in for {@link DraftLock} used by the TelegramService specs.
 *
 * It really enforces mutual exclusion (a held key makes the next acquire return
 * null / withLock return undefined) rather than passing everything through, so
 * the specs exercise the actual "second tap is skipped" behaviour instead of a
 * stub that can never fail. Keys are tracked in a Set, so a test can assert on
 * which locks were taken and simulate a lock already held by another process.
 *
 * TTLs passed to acquire/withLock are recorded too (not enforced — this fake has
 * no clock), so a spec can assert a call site requested the SHORT
 * `ENQUEUE_TTL_SECONDS` rather than silently inheriting `DEFAULT_TTL_SECONDS`;
 * getting that wrong is exactly what would widen the crash-shadows-retry window
 * DraftLock's doc comment warns about.
 */
export interface FakeDraftLock {
  /** Keys currently held. */
  held: Set<string>;
  /** Every key ever acquired, in order — for asserting the guard ran. */
  acquired: string[];
  /** TTL (seconds) requested on each acquire, in the same order as `acquired`. */
  ttlsRequested: number[];
  /** Pre-hold a key to simulate a concurrent holder (or a stale, un-expired lock). */
  hold(key: string): void;
  /** Force-expire a key, as Redis would after the TTL elapses. */
  expire(key: string): void;
  withLock<T>(
    key: string,
    fn: () => Promise<T>,
    opts?: { ttlSeconds?: number },
  ): Promise<T | undefined>;
  acquire(
    key: string,
    ttlSeconds?: number,
  ): Promise<{ key: string; release: () => Promise<void> } | null>;
}

/** Build a fresh fake lock. `failOpen` mimics Redis being unreachable. */
export function makeFakeLock(opts: { failOpen?: boolean } = {}): FakeDraftLock &
  DraftLock {
  const held = new Set<string>();
  const acquired: string[] = [];
  const ttlsRequested: number[] = [];

  const fake: FakeDraftLock = {
    held,
    acquired,
    ttlsRequested,
    hold: (key) => held.add(key),
    expire: (key) => held.delete(key),

    async acquire(key, ttlSeconds = DraftLock.DEFAULT_TTL_SECONDS) {
      acquired.push(key);
      ttlsRequested.push(ttlSeconds);
      // failOpen: Redis is down, so the real DraftLock returns a no-op handle
      // rather than blocking the caller.
      if (opts.failOpen) return { key, release: async () => {} };
      if (held.has(key)) return null;
      held.add(key);
      return {
        key,
        release: async () => {
          held.delete(key);
        },
      };
    },

    async withLock(key, fn, withLockOpts = {}) {
      const handle = await this.acquire(key, withLockOpts.ttlSeconds);
      if (!handle) return undefined;
      try {
        return await fn();
      } finally {
        await handle.release();
      }
    },
  };

  return fake as FakeDraftLock & DraftLock;
}
