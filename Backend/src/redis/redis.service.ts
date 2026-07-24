import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, REDIS_STARTUP_TIMEOUT_MS } from './redis.constants';

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
    await this.client.quit();
  }

  getClient(): Redis {
    return this.client;
  }

  async get<T = string>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`Non-JSON value at key "${key}"; returning raw string`);
      return raw as T;
    }
  }

  async set<T>(key: string, value: T): Promise<'OK'> {
    return this.client.set(key, JSON.stringify(value));
  }

  async setEx<T>(key: string, ttl: number, value: T): Promise<'OK'> {
    return this.client.setex(key, ttl, JSON.stringify(value));
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) > 0;
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    return (await this.client.expire(key, ttl)) === 1;
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async decr(key: string): Promise<number> {
    return this.client.decr(key);
  }

  async scan(pattern: string, count = 100): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        count,
      );
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }

  async flushDb(): Promise<'OK'> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'flushDb() is disabled in production. Use an explicit administrative operation if you intentionally need to clear Redis.',
      );
    }
    return this.client.flushdb();
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
