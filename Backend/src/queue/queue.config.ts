import { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';

/**
 * Build the ioredis connection options BullMQ uses, from the SAME ConfigService
 * values as the app's primary Redis client (see redis.provider.ts). This is
 * intentionally NOT a second Redis configuration: it reads the identical
 * REDIS_HOST / REDIS_PORT / REDIS_PASSWORD env vars so the queue and the rest of
 * the app always point at the same Redis.
 *
 * Why options and not the existing shared client instance:
 *   BullMQ requires a connection with `maxRetriesPerRequest: null` (blocking
 *   commands like BRPOPLPUSH must never time out), and it manages the lifecycle
 *   of its own duplicated connections per Queue/Worker. Handing it a connection
 *   spec (rather than the app's REDIS_CLIENT) lets it create the connections it
 *   needs while still keeping a single source of truth for *where* Redis is.
 */
export function buildQueueConnection(config: ConfigService): RedisOptions {
  const password = config.get<string>('REDIS_PASSWORD');

  return {
    host: config.getOrThrow<string>('REDIS_HOST'),
    port: Number(config.getOrThrow<string>('REDIS_PORT')),
    password: password && password.length > 0 ? password : undefined,
    // Required by BullMQ — blocking commands must not be aborted by a per-request
    // retry cap. Matches the app client's setting in redis.provider.ts.
    maxRetriesPerRequest: null,
  };
}
