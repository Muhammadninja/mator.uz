/**
 * Bounded lifetime for the bot's per-user, in-memory dialogue state
 * (LOW-ING-012).
 *
 * TelegramService keeps several maps keyed by Telegram user id: the wizard
 * session, the message currently on screen, the last validation notice, the
 * stale-button dedup time and a language cache. Most entries are replaced or
 * removed as the dialogue moves on, but a user who simply stops answering left
 * theirs behind for the life of the process, and every distinct sender added
 * one more.
 *
 * The janitor records when each user was last heard from and, on a slow timer,
 * forgets the state of users idle for longer than `idleMs`. That threshold is
 * set above the draft TTL, so a user with a live draft is never touched: by the
 * time they could be, their draft has expired and the draft sweeper has already
 * ended it. Nothing durable lives in these maps (drafts, listings and the
 * language preference are in the database), so forgetting an idle user costs at
 * most a leftover message on their screen.
 */
export interface ForgettableState {
  delete(key: number): unknown;
}

export class TelegramStateJanitor {
  private readonly lastSeen = new Map<number, number>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly idleMs: number,
    private readonly stores: readonly ForgettableState[],
    /** Entries that expire on their own schedule, swept by age: key → time set. */
    private readonly timed: readonly {
      map: Map<number, number>;
      ttlMs: number;
    }[] = [],
  ) {}

  /** Note activity from a user. Called for every update the bot receives. */
  touch(tgUserId: number, now = Date.now()): void {
    this.lastSeen.set(tgUserId, now);
  }

  /** Forget idle users and expired timed entries. Returns users forgotten. */
  sweep(now = Date.now()): number {
    let forgotten = 0;
    for (const [user, seen] of this.lastSeen) {
      if (now - seen < this.idleMs) continue;
      for (const store of this.stores) store.delete(user);
      for (const { map } of this.timed) map.delete(user);
      this.lastSeen.delete(user);
      forgotten += 1;
    }
    for (const { map, ttlMs } of this.timed) {
      for (const [user, at] of map) if (now - at >= ttlMs) map.delete(user);
    }
    return forgotten;
  }

  start(everyMs: number): void {
    this.stop();
    this.timer = setInterval(() => this.sweep(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.lastSeen.clear();
  }

  /** How many users are currently tracked. */
  get size(): number {
    return this.lastSeen.size;
  }
}
