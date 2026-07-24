import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * The single, generic place for Redis-backed read-through caching. Every future
 * consumer (reference lists, categories, brands, regions, config, feature flags,
 * frequently-read entities) goes through this service — no Redis cache logic is
 * duplicated elsewhere.
 *
 * Fail-open by design: the cache is an optimization, never a hard dependency. If
 * Redis is unavailable, reads miss (so the caller loads from the source) and
 * writes are dropped — the request still succeeds. A cache error is logged at
 * `warn`, never thrown.
 *
 * Values are JSON round-tripped by {@link RedisService} (get/setEx), so anything
 * serializable can be cached. Keys always come from {@link RedisKeys}.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Read a cached value. Returns `null` on a miss OR on any Redis failure — the
   * caller treats both identically (load from source), so a cache outage is
   * indistinguishable from a cold cache.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      return await this.redis.get<T>(key);
    } catch (err) {
      this.logger.warn(`Cache read failed for "${key}": ${this.msg(err)}`);
      return null;
    }
  }

  /**
   * Write a value with a TTL. Best effort: a Redis failure is logged and
   * swallowed so a cache-write problem can never fail the request that produced
   * the value.
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.setEx(key, ttlSeconds, value);
    } catch (err) {
      this.logger.warn(`Cache write failed for "${key}": ${this.msg(err)}`);
    }
  }

  /**
   * Delete a cached entry. Best effort (used for explicit busting; automatic
   * invalidation is intentionally not built — see the reference caching design).
   */
  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(`Cache delete failed for "${key}": ${this.msg(err)}`);
    }
  }

  /**
   * Read-through cache — the preferred API.
   *
   *   1. read Redis;
   *   2. return the cached value on a hit;
   *   3. on a miss, run `loader()`;
   *   4. cache the loaded value under `key` for `ttlSeconds`;
   *   5. return the loaded value.
   *
   * `loader` runs at most once per call, and only on a miss. Because a Redis
   * outage surfaces as a miss (see {@link get}), `remember` transparently falls
   * back to `loader()` and still returns data — the caching just becomes a
   * no-op until Redis recovers. `loader` errors are NOT swallowed: a failure to
   * load the real data is a real error and must propagate to the caller.
   */
  async remember<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await loader();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
