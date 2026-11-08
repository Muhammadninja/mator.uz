/**
 * Rate limits of Driver's Village photo updates, and the albums waiting for their
 * sender to confirm. The path is open to any Telegram user by the owner's decision.
 * All of it lives in Redis, shared across processes.
 *
 * Every check fails closed: when Redis cannot answer, the outcome is `unavailable`
 * and the album stops there. The ordinary seller listing flow never comes here.
 *
 * Defaults (overridable, see docs/DEPLOYMENT.md):
 *   DV_PHOTO_ALBUMS_PER_HOUR      20   albums entering the path, per sender
 *   DV_PHOTO_AMBIGUOUS_PER_HOUR    5   position lists shown, per sender
 */
import { randomBytes } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RateLimiter } from '../redis/rate-limiter.service';
import { RATE_LIMITER } from '../redis/rate-limiter.service';
import { RedisKeys } from '../redis/redis.keys';
import {
  RedisService,
  assertRedisBacklogRoom,
  withRedisTimeout,
} from '../redis/redis.service';

const HOUR_S = 60 * 60;
/** How long a sender has to confirm before the album must be sent again. */
const PENDING_TTL_S = 15 * 60;
/** Bot handlers share one queue: a check must not wait out a Redis outage. */
const REDIS_TIMEOUT_MS = 2_000;

export type DvLimitOutcome = 'allowed' | 'limited' | 'unavailable';

/** An album waiting for its sender to confirm. Nothing costly has happened yet. */
export interface DvPendingAlbum {
  tgUserId: number;
  stockId: number;
  code1c: string;
  fileIds: string[];
}

export type DvPendingClaim =
  | { kind: 'claimed'; album: DvPendingAlbum }
  | { kind: 'gone' }
  | { kind: 'not_yours' }
  | { kind: 'unavailable' };

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

@Injectable()
export class DvPhotoLimits {
  private readonly logger = new Logger(DvPhotoLimits.name);
  private readonly albumsPerHour: number;
  private readonly ambiguousPerHour: number;

  constructor(
    private readonly redis: RedisService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    config: ConfigService,
  ) {
    const read = (key: string, fallback: number) =>
      positiveInt(config.get<string>(key), fallback);
    this.albumsPerHour = read('DV_PHOTO_ALBUMS_PER_HOUR', 20);
    this.ambiguousPerHour = read('DV_PHOTO_AMBIGUOUS_PER_HOUR', 5);
  }

  /** One album entering the path, charged before any database lookup. */
  admitAlbum(tgUserId: number): Promise<DvLimitOutcome> {
    return this.consume(RedisKeys.rateDvAlbum(tgUserId), this.albumsPerHour);
  }

  /** The lookup failed on our side, so the album does not count against them. */
  async returnAlbum(tgUserId: number): Promise<void> {
    await this.quietly('return of an album', () =>
      this.redis.decr(RedisKeys.rateDvAlbum(tgUserId)),
    );
  }

  /** One list of positions shown for an ambiguous code, which discloses codes. */
  admitAmbiguousListing(tgUserId: number): Promise<DvLimitOutcome> {
    return this.consume(
      RedisKeys.rateDvAmbiguous(tgUserId),
      this.ambiguousPerHour,
    );
  }

  /** Keep an album until its sender confirms. Null when Redis cannot take it. */
  async savePending(album: DvPendingAlbum): Promise<string | null> {
    const token = randomBytes(9).toString('base64url');
    try {
      await this.bounded('save of a pending album', () =>
        this.redis.setEx(RedisKeys.dvPhotoPending(token), PENDING_TTL_S, album),
      );
      return token;
    } catch (err) {
      this.logger.error(`Pending album not saved: ${this.describe(err)}`);
      return null;
    }
  }

  /**
   * Take a pending album for its own sender, once. DEL returns how many keys it
   * removed, so of any number of taps exactly one sees 1: a repeated button press
   * or a redelivered update cannot start the album twice.
   */
  async claimPending(token: string, tgUserId: number): Promise<DvPendingClaim> {
    const key = RedisKeys.dvPhotoPending(token);
    try {
      const album = await this.bounded('read of a pending album', () =>
        this.redis.get<DvPendingAlbum>(key),
      );
      if (!album) return { kind: 'gone' };
      if (album.tgUserId !== tgUserId) return { kind: 'not_yours' };
      const removed = await this.bounded('claim of a pending album', () =>
        this.redis.del(key),
      );
      return removed === 1 ? { kind: 'claimed', album } : { kind: 'gone' };
    } catch (err) {
      this.logger.error(`Pending album not claimed: ${this.describe(err)}`);
      return { kind: 'unavailable' };
    }
  }

  private async consume(key: string, limit: number): Promise<DvLimitOutcome> {
    try {
      const { allowed } = await this.bounded(`limit ${key}`, () =>
        this.limiter.consume(key, limit, HOUR_S),
      );
      return allowed ? 'allowed' : 'limited';
    } catch (err) {
      this.logger.error(
        `Photo-update limit could not be checked: ${this.describe(err)}`,
      );
      return 'unavailable';
    }
  }

  private async quietly(
    what: string,
    command: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await this.bounded(what, command);
    } catch (err) {
      this.logger.warn(`${what} failed: ${this.describe(err)}`);
    }
  }

  private bounded<T>(what: string, command: () => Promise<T>): Promise<T> {
    assertRedisBacklogRoom(what);
    return withRedisTimeout(command(), REDIS_TIMEOUT_MS, what);
  }

  private describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
