import { ConfigService } from '@nestjs/config';
import type { RedisService } from '../redis/redis.service';
import {
  ALERT_STATE,
  AlertSeverity,
  type AlertChannel,
  type AlertNotification,
} from './alerting.types';
import { RedisWatchdog } from './redis-watchdog.service';

// The one alert that must work while Redis is down: nothing here may touch Redis but the
// PING itself, and the channel is called directly (no queue, no stored state).

const SOURCE = {
  version: '1',
  commit: 'abc1234',
  host: 'vps',
  instance: '',
  pid: 7,
};

function configWith(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function setup(env: Record<string, string> = {}) {
  let healthy = true;
  const ping = jest.fn(() =>
    healthy
      ? Promise.resolve('PONG')
      : Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379')),
  );
  const redis = { getClient: () => ({ ping }) } as unknown as RedisService;
  const sent: AlertNotification[] = [];
  const deliver = jest.fn((n: AlertNotification) => {
    sent.push(n);
    return Promise.resolve();
  });
  const telegram: AlertChannel = {
    name: 'telegram',
    configured: true,
    accepts: (n) => n.severity >= AlertSeverity.WARNING,
    deliver,
  };
  const slack: AlertChannel = {
    name: 'slack',
    configured: false,
    accepts: () => true,
    deliver: jest.fn(),
  };
  const watchdog = new RedisWatchdog(
    redis,
    [telegram, slack],
    SOURCE,
    configWith(env),
  );
  const logger = (watchdog as unknown as { logger: Record<string, unknown> })
    .logger as {
    warn: () => void;
    log: () => void;
    error: () => void;
  };
  for (const level of ['warn', 'log', 'error'] as const) {
    jest.spyOn(logger, level).mockImplementation(() => undefined);
  }
  return {
    watchdog,
    sent,
    deliver,
    ping,
    setHealthy: (value: boolean) => {
      healthy = value;
    },
  };
}

const T = 1_700_000_000_000;
const S = 1000;

describe('RedisWatchdog', () => {
  it('says nothing while Redis answers', async () => {
    const { watchdog, sent } = setup();
    await watchdog.tick(T);
    await watchdog.tick(T + 30 * S);

    expect(sent).toEqual([]);
  });

  it('alerts the channel directly after two failed checks, not after one', async () => {
    const { watchdog, sent, setHealthy } = setup();
    setHealthy(false);

    await watchdog.tick(T);
    expect(sent).toHaveLength(0);
    await watchdog.tick(T + 30 * S);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      state: ALERT_STATE.ACTIVE,
      rule: 'redis_down',
      severity: AlertSeverity.CRITICAL,
      title: 'Redis Unreachable',
      labels: { component: 'redis', environment: 'production' },
      values: {
        status: 'unreachable',
        error: 'connect ECONNREFUSED 127.0.0.1:6379',
        failed_checks: 2,
      },
    });
    expect(sent[0].renotification).toBeUndefined();
  });

  it('sends once while down, then a reminder after ALERT_RENOTIFY_MIN', async () => {
    const { watchdog, sent, setHealthy } = setup();
    setHealthy(false);
    for (let i = 0; i <= 10; i += 1) await watchdog.tick(T + i * 30 * S);
    expect(sent).toHaveLength(1);

    await watchdog.tick(T + 31 * 60 * S);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      renotification: true,
      activeForMs: 31 * 60 * S,
    });
  });

  it('announces the recovery to the channels it alerted, with how long it lasted', async () => {
    const { watchdog, sent, setHealthy } = setup();
    setHealthy(false);
    await watchdog.tick(T);
    await watchdog.tick(T + 30 * S);
    setHealthy(true);

    await watchdog.tick(T + 90 * S);
    await watchdog.tick(T + 120 * S);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      state: ALERT_STATE.RESOLVED,
      severity: AlertSeverity.INFO,
      activeForMs: 90 * S,
    });
  });

  it('a single lost PING is not an outage', async () => {
    const { watchdog, sent, setHealthy } = setup();
    setHealthy(false);
    await watchdog.tick(T);
    setHealthy(true);
    await watchdog.tick(T + 30 * S);
    setHealthy(false);
    await watchdog.tick(T + 60 * S);

    expect(sent).toEqual([]);
  });

  it('tries a channel it could not reach again on the next check', async () => {
    const { watchdog, sent, deliver, setHealthy } = setup();
    setHealthy(false);
    deliver.mockImplementationOnce(() => Promise.reject(new Error('timeout')));

    await watchdog.tick(T);
    await watchdog.tick(T + 30 * S); // the send fails
    await watchdog.tick(T + 60 * S); // and is retried

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
  });

  it('treats a PING that never answers as a failure', async () => {
    const { watchdog, sent, ping } = setup({ ALERT_HEALTH_TIMEOUT_MS: '20' });
    ping.mockImplementation(() => new Promise(() => undefined));

    await watchdog.tick(T);
    await watchdog.tick(T + 30 * S);

    expect(sent).toHaveLength(1);
    expect(sent[0].values.error).toContain('timed out');
  });

  it('honours REDIS_WATCHDOG_FAILURES', async () => {
    const { watchdog, sent, setHealthy } = setup({
      REDIS_WATCHDOG_FAILURES: '3',
    });
    setHealthy(false);
    await watchdog.tick(T);
    await watchdog.tick(T + 30 * S);
    expect(sent).toHaveLength(0);
    await watchdog.tick(T + 60 * S);

    expect(sent).toHaveLength(1);
  });

  it('ignores PINGs that fail because the app is shutting down', async () => {
    const { watchdog, sent, setHealthy } = setup();
    setHealthy(false);
    await watchdog.tick(T);
    watchdog.onModuleDestroy();
    await watchdog.tick(T + 30 * S);

    expect(sent).toEqual([]);
  });

  it('does not start with alerting off', () => {
    const { watchdog } = setup({ ALERTING_ENABLED: 'false' });
    watchdog.onModuleInit();

    expect((watchdog as unknown as { timer?: unknown }).timer).toBeUndefined();
  });
});
