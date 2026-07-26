import { ConfigService } from '@nestjs/config';
import {
  MONITORED_QUEUES,
  SAMPLED_QUEUES,
  resolveBullBoardConfig,
  resolveQueueMonitorConfig,
} from './ops.config';
import { QUEUE_NAMES } from '../queue/queue.constants';

function configWith(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('resolveBullBoardConfig', () => {
  it('is disabled and read-only by default', () => {
    const config = resolveBullBoardConfig(configWith());

    // The safe posture: nothing mounted, nothing mutable.
    expect(config.enabled).toBe(false);
    expect(config.readOnly).toBe(true);
    expect(config.route).toBe('/admin/queues');
  });

  it('enables only on an exact "true"', () => {
    expect(
      resolveBullBoardConfig(configWith({ BULL_BOARD_ENABLED: 'true' }))
        .enabled,
    ).toBe(true);
    expect(
      resolveBullBoardConfig(configWith({ BULL_BOARD_ENABLED: 'TRUE' }))
        .enabled,
    ).toBe(true);
    // Anything ambiguous must not silently expose the dashboard.
    expect(
      resolveBullBoardConfig(configWith({ BULL_BOARD_ENABLED: '1' })).enabled,
    ).toBe(false);
    expect(
      resolveBullBoardConfig(configWith({ BULL_BOARD_ENABLED: 'yes' })).enabled,
    ).toBe(false);
  });

  it('allows mutations only when explicitly opted in', () => {
    const config = resolveBullBoardConfig(
      configWith({ BULL_BOARD_ALLOW_MUTATIONS: 'true' }),
    );
    expect(config.readOnly).toBe(false);
  });

  it('uses a custom route when set', () => {
    const config = resolveBullBoardConfig(
      configWith({ BULL_BOARD_ROUTE: '/internal/q' }),
    );
    expect(config.route).toBe('/internal/q');
  });
});

describe('resolveQueueMonitorConfig', () => {
  it('applies sane defaults with no env set', () => {
    const config = resolveQueueMonitorConfig(configWith());

    // Monitoring is on by default — it is read-only and cheap.
    expect(config.enabled).toBe(true);
    expect(config.intervalSec).toBe(60);
    expect(config.failedThreshold).toBe(25);
    expect(config.waitingThreshold).toBe(100);
    expect(config.waitingGrowthSamples).toBe(3);
    expect(config.cooldownMin).toBe(15);
  });

  it('reads overrides from the environment', () => {
    const config = resolveQueueMonitorConfig(
      configWith({
        QUEUE_MONITOR_INTERVAL_SEC: '30',
        QUEUE_ALERT_FAILED_THRESHOLD: '5',
        QUEUE_ALERT_COOLDOWN_MIN: '60',
      }),
    );

    expect(config.intervalSec).toBe(30);
    expect(config.failedThreshold).toBe(5);
    expect(config.cooldownMin).toBe(60);
  });

  it('falls back to defaults for invalid values', () => {
    const config = resolveQueueMonitorConfig(
      configWith({
        QUEUE_MONITOR_INTERVAL_SEC: 'abc',
        QUEUE_ALERT_FAILED_THRESHOLD: '0',
        QUEUE_ALERT_COOLDOWN_MIN: '-5',
      }),
    );

    // A zero interval or cooldown would busy-loop / spam; never accept them.
    expect(config.intervalSec).toBe(60);
    expect(config.failedThreshold).toBe(25);
    expect(config.cooldownMin).toBe(15);
  });

  it('can be disabled explicitly', () => {
    expect(
      resolveQueueMonitorConfig(configWith({ QUEUE_MONITOR_ENABLED: 'false' }))
        .enabled,
    ).toBe(false);
  });
});

describe('MONITORED_QUEUES', () => {
  it('covers every registered queue', () => {
    // Guards the "a new queue is silently unmonitored" regression.
    expect([...MONITORED_QUEUES].sort()).toEqual(
      Object.values(QUEUE_NAMES).sort(),
    );
  });
});

describe('SAMPLED_QUEUES', () => {
  it('covers every registered queue except the alerts queue', () => {
    // A new queue must be sampled by default (the same regression guard as
    // above), while `alerts` stays excluded: monitoring the alert-delivery
    // queue with the system that delivers alerts cannot report its own failure.
    expect([...SAMPLED_QUEUES].sort()).toEqual(
      Object.values(QUEUE_NAMES)
        .filter((queue) => queue !== QUEUE_NAMES.ALERTS)
        .sort(),
    );
    expect(SAMPLED_QUEUES).not.toContain(QUEUE_NAMES.ALERTS);
  });
});
