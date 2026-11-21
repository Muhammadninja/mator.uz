import { ConfigService } from '@nestjs/config';
import type { RedisService } from '../../redis/redis.service';
import { AlertSeverity } from '../alerting.types';
import {
  RedisMemoryRule,
  formatBytes,
  parseRedisMemoryInfo,
} from './redis-memory.rule';

const GB = 1024 ** 3;

function configWith(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function info(
  used: number,
  max: number,
  policy = 'noeviction',
  system = 8 * GB,
) {
  return [
    '# Memory',
    `used_memory:${used}`,
    `used_memory_human:${formatBytes(used)}`,
    `maxmemory:${max}`,
    `maxmemory_policy:${policy}`,
    `total_system_memory:${system}`,
    '',
  ].join('\r\n');
}

function rule(raw: string | Error, env: Record<string, string> = {}) {
  const redis = {
    getClient: () => ({
      info: jest.fn(() =>
        raw instanceof Error ? Promise.reject(raw) : Promise.resolve(raw),
      ),
    }),
  } as unknown as RedisService;
  return new RedisMemoryRule(redis, configWith(env));
}

describe('RedisMemoryRule', () => {
  it('stays quiet well below the limit with noeviction', async () => {
    expect((await rule(info(0.5 * GB, 2 * GB)).evaluate()).firing).toEqual([]);
  });

  it('alerts at 85% of maxmemory and is CRITICAL from 95%', async () => {
    const warn = await rule(info(1.8 * GB, 2 * GB)).evaluate();
    const crit = await rule(info(1.95 * GB, 2 * GB)).evaluate();

    expect(warn.firing[0]).toMatchObject({
      rule: 'redis_memory',
      labels: { check: 'memory' },
      severity: AlertSeverity.ERROR,
      values: {
        usage: '90%',
        used: '1.8 GB',
        limit: '2.0 GB (maxmemory)',
        threshold: '85%',
      },
    });
    expect(crit.firing[0].severity).toBe(AlertSeverity.CRITICAL);
  });

  it('measures against the machine RAM when no maxmemory is set', async () => {
    const { firing } = await rule(
      info(7 * GB, 0, 'noeviction', 8 * GB),
    ).evaluate();

    expect(firing[0].values.limit).toBe('8.0 GB (machine RAM)');
  });

  it('warns that an evicting policy can drop queued jobs', async () => {
    const { firing } = await rule(
      info(0.1 * GB, 2 * GB, 'allkeys-lru'),
    ).evaluate();

    expect(firing).toEqual([
      expect.objectContaining({
        labels: { check: 'eviction_policy' },
        severity: AlertSeverity.WARNING,
        values: { policy: 'allkeys-lru', required: 'noeviction' },
      }),
    ]);
  });

  it('ignores the policy when nothing caps memory (no eviction can happen)', async () => {
    const { firing } = await rule(info(0.1 * GB, 0, 'allkeys-lru')).evaluate();

    expect(firing).toEqual([]);
  });

  it('throws when Redis does not answer, which the evaluator isolates', async () => {
    await expect(
      rule(new Error('Connection is closed')).evaluate(),
    ).rejects.toThrow('Connection is closed');
  });

  it('reports the recovered reading on resolution', async () => {
    await expect(
      rule(info(GB, 2 * GB)).resolvedValuesFor({ check: 'memory' }),
    ).resolves.toMatchObject({ usage: '50%' });
  });
});

describe('parseRedisMemoryInfo', () => {
  it('reads missing fields as zero / empty', () => {
    expect(parseRedisMemoryInfo('# Memory\r\nused_memory:42\r\n')).toEqual({
      usedBytes: 42,
      maxBytes: 0,
      systemBytes: 0,
      policy: '',
    });
  });
});
