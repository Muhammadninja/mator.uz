import { DraftLock } from '../redis/draft-lock.service';

/**
 * The type of a TelegramService built by the specs' `Object.create(prototype)`
 * harness, which drives the class's PRIVATE helpers directly (no Nest DI, no live
 * bot) and replaces its injected collaborators with mocks.
 *
 * Why an index signature and NOT `TelegramService & Record<string, any>`: an
 * intersection does not relax visibility. For a name the class already declares,
 * TypeScript resolves against the class declaration and reports TS2341 ("private
 * and only accessible within class") — the `Record` half is never consulted, so
 * that formulation produced an error on every `svc.wizard` / `svc.handlePhotos`
 * access while looking like it should work.
 *
 * A bare index signature has no declared members to resolve against, so both the
 * private helpers under test and the mock-only fields the harness assigns
 * (`sendStepPrompt`, `discardSessionPhotos`, …) type-check. This deliberately
 * keeps the looseness INSIDE the test harness: production visibility is
 * unchanged, and nothing here widens the service's real API.
 */
export type TelegramServiceHarness = Record<string, any>;

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
