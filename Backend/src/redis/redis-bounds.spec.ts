// REL-001: what a Redis that stops answering does to each kind of caller.
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { redisProvider } from './redis.provider';
import { buildQueueConnection } from '../queue/queue.config';
import { CacheService } from './cache.service';
import {
  RedisService,
  RedisTimeoutError,
  RedisUnavailableError,
} from './redis.service';
import { REDIS_COMMAND_TIMEOUT_MS } from './redis.constants';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { OptionalJwtAuthGuard, JwtUnlessAnonymousGuard } from '../auth/guards/optional-jwt-auth.guard';
import { TokenService } from '../auth/tokens/token.service';
import { HealthController } from '../health/health.controller';

const never = () => new Promise<never>(() => undefined);

function respond(exception: unknown) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ headersSent: false, status }),
      getRequest: () => ({ method: 'GET', url: '/v1/auth/me' }),
    }),
  } as unknown as ArgumentsHost;
  const filter = new HttpExceptionFilter();
  jest.spyOn((filter as any).logger, 'error').mockImplementation();
  filter.catch(exception, host);
  return { status, json };
}

describe('Redis that never answers (REL-001)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const silent = () =>
    new RedisService({ exists: jest.fn(never), get: jest.fn(never) } as never);

  it('a blacklist check gives up at the bound and becomes a 503', async () => {
    const tokens = Object.create(TokenService.prototype);
    tokens.redis = silent();
    const check = tokens.isAccessTokenBlacklisted('jti') as Promise<boolean>;
    const settled = expect(check).rejects.toBeInstanceOf(RedisTimeoutError);
    await jest.advanceTimersByTimeAsync(REDIS_COMMAND_TIMEOUT_MS);
    await settled;

    const { status, json } = respond(new RedisTimeoutError('EXISTS', 2000));
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
    );
  });

  it('a cache read follows its documented fallback: a miss', async () => {
    const cache = new CacheService(silent());
    jest.spyOn((cache as any).logger, 'warn').mockImplementation();
    const read = cache.get('k');
    await jest.advanceTimersByTimeAsync(CacheService.REDIS_TIMEOUT_MS);
    await expect(read).resolves.toBeNull();
  });
});

describe('RedisService errors', () => {
  it.each(['Command timed out', 'Connection is closed.', 'connect ECONNREFUSED 127.0.0.1:6379'])(
    'reports "%s" as unavailable',
    async (message) => {
      const service = new RedisService({
        exists: jest.fn().mockRejectedValue(new Error(message)),
      } as never);
      await expect(service.exists('k')).rejects.toBeInstanceOf(RedisUnavailableError);
    },
  );

  it('reports the retry limit as unavailable', async () => {
    const err = Object.assign(new Error('Reached the max retries'), {
      name: 'MaxRetriesPerRequestError',
    });
    const service = new RedisService({ get: jest.fn().mockRejectedValue(err) } as never);
    await expect(service.get('k')).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it('passes a genuine command error through unchanged', async () => {
    const err = new Error('WRONGTYPE Operation against a key');
    const service = new RedisService({ get: jest.fn().mockRejectedValue(err) } as never);
    await expect(service.get('k')).rejects.toBe(err);
  });

  it('works again as soon as Redis answers', async () => {
    const exists = jest
      .fn()
      .mockRejectedValueOnce(new Error('Connection is closed.'))
      .mockResolvedValueOnce(1);
    const service = new RedisService({ exists } as never);
    await expect(service.exists('k')).rejects.toBeInstanceOf(RedisUnavailableError);
    await expect(service.exists('k')).resolves.toBe(true);
  });
});

describe('client settings', () => {
  const config = { get: () => undefined, getOrThrow: () => '6379' } as never;

  it('bounds the request-path client', () => {
    const client = (redisProvider as { useFactory: (c: never) => any }).useFactory(config);
    expect(client.options.maxRetriesPerRequest).toBe(1);
    expect(client.options.commandTimeout).toBe(REDIS_COMMAND_TIMEOUT_MS);
    client.disconnect();
  });

  it('leaves BullMQ the unlimited retries its blocking commands need', () => {
    const options = buildQueueConnection(config);
    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options).not.toHaveProperty('commandTimeout');
  });
});

describe('guards during an outage', () => {
  const outage = new RedisUnavailableError('down');

  it.each([
    ['optional', new OptionalJwtAuthGuard()],
    ['unless-anonymous', new JwtUnlessAnonymousGuard()],
  ])('the %s guard refuses instead of treating the caller as a guest', (_n, guard) => {
    expect(() => guard.handleRequest(outage, undefined as never)).toThrow(outage);
  });
});

describe('health', () => {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([{}]) };

  it('reports Redis being down as degraded, without failing the probe', async () => {
    const redis = { getClient: () => ({ ping: jest.fn().mockRejectedValue(new Error('x')) }) };
    const health = new HealthController(prisma as never, undefined, redis as never);
    await expect(health.ready()).resolves.toEqual({
      status: 'degraded',
      database: 'up',
      redis: 'down',
    });
  });

  it('reports a working Redis', async () => {
    const redis = { getClient: () => ({ ping: jest.fn().mockResolvedValue('PONG') }) };
    const health = new HealthController(prisma as never, undefined, redis as never);
    await expect(health.ready()).resolves.toEqual({
      status: 'ok',
      database: 'up',
      redis: 'up',
    });
  });
});
