import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const logger = new Logger('Redis');
    const password = config.get<string>('REDIS_PASSWORD');

    const options: RedisOptions = {
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: Number(config.getOrThrow<string>('REDIS_PORT')),
      password: password && password.length > 0 ? password : undefined,
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number): number => Math.min(times * 200, 5_000),
    };

    const client = new Redis(options);

    client.on('connect', () => logger.log('Connection established'));
    client.on('ready', () => logger.log('Client ready'));
    client.on('error', (err: Error) =>
      logger.error(`Client error: ${err.message}`, err.stack),
    );
    client.on('close', () => logger.warn('Connection closed'));
    client.on('reconnecting', (delay: number) =>
      logger.warn(`Reconnecting in ${delay}ms`),
    );

    return client;
  },
};
