import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * DraftLock — a short-lived, self-expiring mutex for the draft/preview flow.
 *
 * ROLE (read this before adding a call site): this is a *short-circuit*, never a
 * decider. Every operation it guards is ALREADY correct on its own, because
 * PostgreSQL enforces it — `cloneForPhotoReplacement` terminates the source under
 * its observed (status, version) inside a transaction, `claimPreviewSend` is a
 * compare-and-set on `previewSentAt IS NULL`, and `reopenForEdit` is versioned.
 * The lock exists to stop a double-tap from doing redundant *work* (a second
 * Cloudinary read, a second Telegram album, a second queue round-trip) before the
 * DB rejects it — not to make the outcome correct.
 *
 * The consequence is the rule this whole layer is built on: **DB wins over
 * Redis.** A lost lock means "someone else is doing this right now, skip"; it
 * never means "this succeeded". An acquired lock means nothing at all until the
 * DB guard downstream also passes. If Redis is unavailable, every acquire
 * fails OPEN (returns true) — a flaky cache must never block a seller from
 * publishing, because the DB is still there to reject the duplicate.
 *
 * Stale-safety: locks are acquired with `SET NX EX`, so a holder that crashes
 * mid-operation cannot wedge the key — Redis expires it within `ttlSeconds` and
 * the next attempt proceeds. Release is best-effort and *fenced*: it deletes the
 * key only if it still carries this holder's token, so a slow holder whose lock
 * already expired can never delete the lock a newer holder now owns.
 */
@Injectable()
export class DraftLock {
  private readonly logger = new Logger(DraftLock.name);

  /**
   * Default holding time, for locks that wrap a Prisma transaction plus one
   * Telegram/Cloudinary call (clone, preview, reopen) — sub-second in practice,
   * but external I/O can stall, so this leaves real headroom. A crashed holder
   * self-heals after one TTL: until then, the key is a false "busy" that skips
   * legitimate retries too, so this must stay sized to the ACTUAL worst case of
   * its critical section, not padded "to be safe" — a longer TTL directly
   * extends how long a crash can shadow a real retry.
   */
  static readonly DEFAULT_TTL_SECONDS = 30;

  /**
   * Holding time for locks around pure Redis/BullMQ calls (image-job enqueue:
   * `queue.add`/`getJob`/`remove` plus one Prisma update) — no Cloudinary, no
   * Telegram. Deliberately much shorter than {@link DEFAULT_TTL_SECONDS}:
   *
   * A crashed holder here is the exact failure that matters for retries — e.g.
   * the worker dies mid-enqueue, the row is left PROCESSING, the seller taps
   * "🔁 Повторить", `resetFailedImages` correctly flips the row in Postgres, but
   * `enqueueImageJob('reenqueue')` would find the OLD lock still technically
   * "held" and skip the retry as a false duplicate — even though `reenqueueImage`
   * is independently idempotent (it removes any stale BullMQ job by id first) and
   * has nothing to collide with. A short TTL bounds that shadow window tightly
   * instead of inheriting 30s sized for a different kind of critical section.
   */
  static readonly ENQUEUE_TTL_SECONDS = 5;

  /**
   * Fenced release: DEL only when the stored value still equals our token.
   * Compare-and-delete must be atomic, hence Lua — a GET-then-DEL could observe
   * our token, lose the CPU, and delete a lock a newer holder acquired in the gap.
   */
  private static readonly RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end
    return 0
  `;

  constructor(private readonly redis: RedisService) {}

  /**
   * Try to take `key` for `ttlSeconds`. Returns a release handle on success, or
   * null when another holder has it (caller should skip — it is a duplicate).
   *
   * Fails OPEN: if Redis errors, this returns a no-op handle rather than null.
   * Blocking a legitimate action because a cache is down would be a worse
   * failure than doing the work twice, and the DB guard still rejects the double.
   */
  async acquire(
    key: string,
    ttlSeconds: number = DraftLock.DEFAULT_TTL_SECONDS,
  ): Promise<DraftLockHandle | null> {
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try {
      const res = await this.redis
        .getClient()
        .set(key, token, 'EX', ttlSeconds, 'NX');
      if (res !== 'OK') return null; // held by someone else — duplicate tap
      return { key, token, release: () => this.release(key, token) };
    } catch (err) {
      this.logger.warn(
        `Lock acquire failed for "${key}" (${err instanceof Error ? err.message : String(err)}) — proceeding unguarded; the DB guard still applies.`,
      );
      return { key, token, release: async () => {} };
    }
  }

  /**
   * Run `fn` while holding `key`; return `onBusy` (default undefined) without
   * running it when the lock is already held. The lock is always released, even
   * if `fn` throws — the critical section must not outlive the operation.
   */
  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    opts: { ttlSeconds?: number } = {},
  ): Promise<T | undefined> {
    const handle = await this.acquire(
      key,
      opts.ttlSeconds ?? DraftLock.DEFAULT_TTL_SECONDS,
    );
    if (!handle) return undefined;
    try {
      return await fn();
    } finally {
      await handle.release();
    }
  }

  /**
   * Best-effort fenced release. Never throws: the lock's TTL is the real
   * guarantee, so a failed release costs at most one TTL of extra waiting.
   */
  private async release(key: string, token: string): Promise<void> {
    try {
      await this.redis
        .getClient()
        .eval(DraftLock.RELEASE_SCRIPT, 1, key, token);
    } catch (err) {
      this.logger.debug(
        `Lock release failed for "${key}" (${err instanceof Error ? err.message : String(err)}) — it will expire on its own.`,
      );
    }
  }
}

/** A held lock. `release` is idempotent and never throws. */
export interface DraftLockHandle {
  key: string;
  token: string;
  release: () => Promise<void>;
}
