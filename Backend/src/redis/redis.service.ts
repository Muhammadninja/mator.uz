import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import {
  REDIS_CLIENT,
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_QUIT_TIMEOUT_MS,
  REDIS_STARTUP_TIMEOUT_MS,
} from './redis.constants';
import {
  RedisTimeoutError,
  RedisUnavailableError,
  assertRedisBacklogRoom,
  trackUnansweredRedisCommand,
} from './redis-backlog';

export {
  RedisBacklogError,
  RedisTimeoutError,
  RedisUnavailableError,
  assertRedisBacklogRoom,
  trackUnansweredRedisCommand,
} from './redis-backlog';

/**
 * Bound ONE Redis command for a caller that must not wait out an outage.
 *
 * The shared client rejects a command only after its own command timeout or a
 * failed reconnect, and BullMQ's connections wait out an outage entirely. Callers
 * that must not wait that long use this: it turns "no reply within `ms`" into an
 * ordinary rejection they already treat as Redis being unavailable.
 *
 * It does NOT cancel the command: ioredis may still run it once the connection
 * returns (exactly as its own `commandTimeout` would). Bound only
 * commands that are safe to complete late. A command given up on is counted
 * against the process-wide cap in redis-backlog.ts until it settles; callers
 * check that cap (assertRedisBacklogRoom) before issuing. Rejects with
 * RedisTimeoutError, so a caller can tell "Redis is not answering" from "Redis
 * answered with an error".
 */
export function withRedisTimeout<T>(
  command: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      trackUnansweredRedisCommand(command);
      reject(new RedisTimeoutError(what, ms));
    }, ms);
  });
  return Promise.race([command, timeout]).finally(() => clearTimeout(timer));
}

/** ioredis's own ways of saying the server cannot be reached. */
function isConnectivityFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'MaxRetriesPerRequestError' ||
    /Command timed out|Connection is closed|Stream isn't writeable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE/.test(
      err.message,
    )
  );
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.verifyConnection();
      this.logger.log('Connectivity verified');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.client.disconnect(false);
      throw new Error(
        `Redis is required infrastructure and could not be reached: ${message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    // A QUIT during an outage has nobody to answer it; shutdown must still finish.
    try {
      await withRedisTimeout(this.client.quit(), REDIS_QUIT_TIMEOUT_MS, 'QUIT');
    } catch {
      this.client.disconnect(false);
    }
  }

  getClient(): Redis {
    return this.client;
  }

  async get<T = string>(key: string): Promise<T | null> {
    const raw = await this.bounded('GET', () => this.client.get(key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`Non-JSON value at key "${key}"; returning raw string`);
      return raw as T;
    }
  }

  async set<T>(key: string, value: T): Promise<'OK'> {
    return this.bounded('SET', () => this.client.set(key, JSON.stringify(value)));
  }

  async setEx<T>(key: string, ttl: number, value: T): Promise<'OK'> {
    return this.bounded('SETEX', () =>
      this.client.setex(key, ttl, JSON.stringify(value)),
    );
  }

  /** SET key claim NX EX ttl. True only for the caller that created the key. */
  async setNxEx(key: string, ttl: number, claim: string): Promise<boolean> {
    return (
      (await this.bounded('SET NX', () =>
        this.client.set(key, claim, 'EX', ttl, 'NX'),
      )) === 'OK'
    );
  }

  async del(key: string): Promise<number> {
    return this.bounded('DEL', () => this.client.del(key));
  }

  async exists(key: string): Promise<boolean> {
    return (await this.bounded('EXISTS', () => this.client.exists(key))) > 0;
  }

  /** EXISTS over several keys in one round trip: true when any of them is set. */
  async existsAny(keys: string[]): Promise<boolean> {
    if (keys.length === 0) return false;
    return (
      (await this.bounded('EXISTS', () => this.client.exists(...keys))) > 0
    );
  }

  /** One EXISTS per key, pipelined into a single round trip, in input order. */
  async existsEach(keys: string[]): Promise<boolean[]> {
    if (keys.length === 0) return [];
    const replies = await this.bounded('EXISTS', async () => {
      const pipeline = this.client.pipeline();
      for (const key of keys) pipeline.exists(key);
      return pipeline.exec();
    });
    if (!replies || replies.length !== keys.length) {
      throw new RedisUnavailableError('Redis EXISTS pipeline returned no reply');
    }
    return replies.map(([err, count]) => {
      if (err) throw err;
      return Number(count) > 0;
    });
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    return (
      (await this.bounded('EXPIRE', () => this.client.expire(key, ttl))) === 1
    );
  }

  async ttl(key: string): Promise<number> {
    return this.bounded('TTL', () => this.client.ttl(key));
  }

  async incr(key: string): Promise<number> {
    return this.bounded('INCR', () => this.client.incr(key));
  }

  async decr(key: string): Promise<number> {
    return this.bounded('DECR', () => this.client.decr(key));
  }

  async scan(pattern: string, count = 100): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.bounded('SCAN', () =>
        this.client.scan(cursor, 'MATCH', pattern, 'COUNT', count),
      );
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }

  /** Run a Lua script atomically. */
  async evalScript<T>(
    script: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<T> {
    return this.bounded(
      'EVAL',
      () => this.client.eval(script, keys.length, ...keys, ...args) as Promise<T>,
    );
  }

  async flushDb(): Promise<'OK'> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'flushDb() is disabled in production. Use an explicit administrative operation if you intentionally need to clear Redis.',
      );
    }
    return this.client.flushdb();
  }

  /**
   * Every command here answers within the bound or rejects with
   * RedisUnavailableError, which the HTTP layer turns into a 503. A caller whose
   * contract is to carry on without Redis (CacheService) catches it; everything
   * guarding security or spending lets it through, so an outage refuses rather
   * than waives the check.
   */
  private async bounded<T>(what: string, run: () => Promise<T>): Promise<T> {
    assertRedisBacklogRoom(what);
    try {
      return await withRedisTimeout(run(), REDIS_COMMAND_TIMEOUT_MS, what);
    } catch (err) {
      if (err instanceof RedisUnavailableError) throw err;
      if (isConnectivityFailure(err)) {
        throw new RedisUnavailableError(
          `Redis ${what} failed: ${(err as Error).message}`,
        );
      }
      throw err;
    }
  }

  private async verifyConnection(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `connection timed out after ${REDIS_STARTUP_TIMEOUT_MS}ms`,
            ),
          ),
        REDIS_STARTUP_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([this.connectAndPing(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async connectAndPing(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
    await this.client.ping();
  }
}
