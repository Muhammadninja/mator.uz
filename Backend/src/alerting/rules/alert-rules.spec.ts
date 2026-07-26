import { ConfigService } from '@nestjs/config';
import { Counter, Histogram, Registry } from 'prom-client';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import type { MetricsService } from '../../metrics/metrics.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedisService } from '../../redis/redis.service';
import { IMAGE_DURATION_BUCKETS } from '../../metrics/metrics.config';
import { AlertSeverity, type AlertRule } from '../alerting.types';
import { BackendHealthRule, truncate } from './backend-health.rule';
import { ImageLatencyRule } from './image-latency.rule';
import { QueueBacklogRule, queueLabel } from './queue-backlog.rule';
import { SmsFailureRule } from './sms-failure.rule';

/**
 * Rule-level behaviour. Each rule is exercised through its public `evaluate`
 * against real prom-client metrics (not mocked metric objects), so the windowing
 * arithmetic and the label handling are covered end to end.
 */

function configWith(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

/** A queue stub reporting a fixed waiting depth. */
function stubQueue(waiting: number): Queue {
  return {
    getJobCounts: jest.fn().mockResolvedValue({ waiting }),
  } as unknown as Queue;
}

describe('QueueBacklogRule', () => {
  it('fires when waiting exceeds the queue threshold', async () => {
    const rule = new QueueBacklogRule(
      configWith({ IMAGE_QUEUE_ALERT_THRESHOLD: '100' }),
      stubQueue(186),
    );

    const { firing } = await rule.evaluate();

    expect(firing).toHaveLength(1);
    expect(firing[0]).toMatchObject({
      rule: 'queue_backlog',
      labels: { queue: QUEUE_NAMES.IMAGE_PROCESSING },
      title: 'Image Processing Queue Backlog',
    });
    expect(firing[0].values).toEqual({ waiting: 186, threshold: 100 });
  });

  it('stays silent at or below the threshold', async () => {
    const rule = new QueueBacklogRule(
      configWith({ IMAGE_QUEUE_ALERT_THRESHOLD: '100' }),
      stubQueue(100),
    );

    expect((await rule.evaluate()).firing).toHaveLength(0);
  });

  it('escalates to critical at twice the threshold', async () => {
    const rule = new QueueBacklogRule(
      configWith({ IMAGE_QUEUE_ALERT_THRESHOLD: '100' }),
      stubQueue(250),
    );

    expect((await rule.evaluate()).firing[0].severity).toBe(
      AlertSeverity.CRITICAL,
    );
  });

  it('alerts per queue, so one backlog never masks another', async () => {
    const rule = new QueueBacklogRule(
      configWith({
        IMAGE_QUEUE_ALERT_THRESHOLD: '100',
        SMS_QUEUE_ALERT_THRESHOLD: '50',
      }),
      stubQueue(150),
      stubQueue(80),
    );

    const queues = (await rule.evaluate()).firing
      .map((f) => f.labels.queue)
      .sort();

    expect(queues).toEqual([QUEUE_NAMES.IMAGE_PROCESSING, QUEUE_NAMES.SMS]);
  });

  it('does not report a backlog when the queue cannot be sampled', async () => {
    // A Redis error must not read as "recovered" — that would resolve a real
    // alert. Redis being down is covered by BackendHealthRule instead.
    const broken = {
      getJobCounts: jest.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as Queue;
    const rule = new QueueBacklogRule(configWith(), broken);

    expect((await rule.evaluate()).firing).toHaveLength(0);
  });

  it('is inert with no queues wired', async () => {
    expect(
      (await new QueueBacklogRule(configWith()).evaluate()).firing,
    ).toEqual([]);
  });

  describe('resolvedValuesFor', () => {
    it('re-reads the queue so a resolution reports the RECOVERED depth', async () => {
      // Echoing the tripping value ("Current: 186") would contradict the word
      // "Resolved" — the message must show the number it came back down to.
      const queue = stubQueue(18);
      const rule = new QueueBacklogRule(
        configWith({ IMAGE_QUEUE_ALERT_THRESHOLD: '100' }),
        queue,
      );

      const values = await rule.resolvedValuesFor({
        queue: QUEUE_NAMES.IMAGE_PROCESSING,
      });

      expect(values).toEqual({ current: 18, threshold: 100 });
    });

    it('falls back to undefined when the queue cannot be re-read', async () => {
      const broken = {
        getJobCounts: jest.fn().mockRejectedValue(new Error('redis down')),
      } as unknown as Queue;
      const rule = new QueueBacklogRule(configWith(), broken);

      // The alert still clears; it just carries less detail.
      expect(
        await rule.resolvedValuesFor({ queue: QUEUE_NAMES.IMAGE_PROCESSING }),
      ).toBeUndefined();
    });

    it('returns undefined for a label naming no known queue', async () => {
      const rule = new QueueBacklogRule(configWith(), stubQueue(5));

      expect(await rule.resolvedValuesFor({})).toBeUndefined();
    });
  });
});

describe('rule dashboard declarations', () => {
  it('every rule points at a dashboard that actually exists', () => {
    // Guards the "renamed the dashboard, forgot the alert link" regression:
    // these UIDs are the ones scripts/grafana/* generates.
    const declared: [AlertRule, string][] = [
      [new QueueBacklogRule(configWith()), 'mator-bullmq'],
      [
        new ImageLatencyRule({} as never, configWith()),
        'mator-image-processing',
      ],
      [new SmsFailureRule({} as never, configWith()), 'mator-sms'],
      [
        new BackendHealthRule({} as never, {} as never, configWith()),
        'mator-backend-overview',
      ],
    ];

    for (const [rule, uid] of declared) {
      expect(rule.dashboardUrl).toContain(uid);
    }
  });

  it('templates the queue backlog link so it lands on the right queue', () => {
    // Without this the link would open a multi-queue overview the operator has
    // to filter by hand — the exact step it exists to remove.
    expect(new QueueBacklogRule(configWith()).dashboardUrl).toContain(
      '{{queue}}',
    );
  });

  it('declares dashboards as RELATIVE paths, never a hardcoded host', () => {
    // So the same code points at staging Grafana in staging.
    expect(new QueueBacklogRule(configWith()).dashboardUrl).toMatch(/^\//);
  });
});

describe('queueLabel', () => {
  it('title-cases a hyphenated queue name', () => {
    expect(queueLabel('image-processing')).toBe('Image Processing');
    expect(queueLabel('sms')).toBe('Sms');
  });
});

describe('ImageLatencyRule', () => {
  /** A real histogram plus a MetricsService exposing it. */
  function buildMetrics() {
    const registry = new Registry();
    const histogram = new Histogram({
      name: 'test_image_processing_duration_seconds',
      help: 'test',
      labelNames: ['result'] as const,
      buckets: IMAGE_DURATION_BUCKETS,
      registers: [registry],
    });
    const metrics = {
      imageProcessingDurationMetric: histogram,
    } as unknown as MetricsService;
    return { histogram, metrics };
  }

  const env = {
    IMAGE_PROCESSING_P95_THRESHOLD: '45',
    ALERT_P95_MIN_SAMPLES: '5',
  };

  it('establishes a baseline on the first evaluation without alerting', async () => {
    const { histogram, metrics } = buildMetrics();
    for (let i = 0; i < 20; i++) histogram.observe({ result: 'success' }, 120);
    const rule = new ImageLatencyRule(metrics, configWith(env));

    // Cumulative history is not "this window" — the first tick can only baseline.
    expect((await rule.evaluate()).firing).toHaveLength(0);
  });

  it('fires when the in-window P95 exceeds the threshold', async () => {
    const { histogram, metrics } = buildMetrics();
    const rule = new ImageLatencyRule(metrics, configWith(env));
    await rule.evaluate(); // baseline

    for (let i = 0; i < 20; i++) histogram.observe({ result: 'success' }, 60);

    const { firing } = await rule.evaluate();

    expect(firing).toHaveLength(1);
    expect(firing[0]).toMatchObject({
      rule: 'image_processing_latency',
      title: 'Image Processing',
    });
    expect(firing[0].values.threshold).toBe('45 sec');
  });

  it('stays silent when in-window latency is healthy', async () => {
    const { histogram, metrics } = buildMetrics();
    const rule = new ImageLatencyRule(metrics, configWith(env));
    await rule.evaluate();

    for (let i = 0; i < 20; i++) histogram.observe({ result: 'success' }, 5);

    expect((await rule.evaluate()).firing).toHaveLength(0);
  });

  it('ignores a window with too few samples for a meaningful quantile', async () => {
    const { histogram, metrics } = buildMetrics();
    const rule = new ImageLatencyRule(metrics, configWith(env));
    await rule.evaluate();

    // Two very slow images is not a trend — a P95 over 2 samples is noise.
    histogram.observe({ result: 'success' }, 300);
    histogram.observe({ result: 'success' }, 300);

    expect((await rule.evaluate()).firing).toHaveLength(0);
  });

  it('recovers once the slow observations age out of the window', async () => {
    jest.useFakeTimers();
    try {
      const { histogram, metrics } = buildMetrics();
      const rule = new ImageLatencyRule(metrics, configWith(env));
      await rule.evaluate();

      for (let i = 0; i < 20; i++) histogram.observe({ result: 'success' }, 90);
      expect((await rule.evaluate()).firing).toHaveLength(1);

      // Advance past the 5-minute window and record only fast work. The slow
      // observations are now BEFORE the window's lower edge, so they no longer
      // count. A cumulative (non-windowed) read would still be dominated by
      // them and would never recover — the regression windowing prevents.
      jest.advanceTimersByTime(6 * 60 * 1000);
      for (let i = 0; i < 20; i++) histogram.observe({ result: 'success' }, 2);
      await rule.evaluate();

      jest.advanceTimersByTime(6 * 60 * 1000);
      for (let i = 0; i < 20; i++) histogram.observe({ result: 'success' }, 2);
      expect((await rule.evaluate()).firing).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts failures too — a timing-out job is the slowness worth paging on', async () => {
    const { histogram, metrics } = buildMetrics();
    const rule = new ImageLatencyRule(metrics, configWith(env));
    await rule.evaluate();

    for (let i = 0; i < 20; i++) histogram.observe({ result: 'failure' }, 120);

    expect((await rule.evaluate()).firing).toHaveLength(1);
  });
});

describe('SmsFailureRule', () => {
  function buildMetrics() {
    const registry = new Registry();
    const counter = new Counter({
      name: 'test_sms_failed_total',
      help: 'test',
      labelNames: ['provider', 'template', 'reason'] as const,
      registers: [registry],
    });
    const metrics = { smsFailedMetric: counter } as unknown as MetricsService;
    return { counter, metrics };
  }

  const env = { SMS_FAILURE_THRESHOLD: '10', ALERT_RATE_WINDOW_MIN: '5' };

  function fail(
    counter: Counter<string>,
    provider: string,
    times: number,
  ): void {
    for (let i = 0; i < times; i++) {
      counter.inc({ provider, template: 'otp', reason: 'timeout' });
    }
  }

  it('baselines on first sight of a provider without alerting', async () => {
    const { counter, metrics } = buildMetrics();
    fail(counter, 'eskiz', 500);
    const rule = new SmsFailureRule(metrics, configWith(env));

    // 500 cumulative failures since boot is not 500 failures in five minutes.
    expect((await rule.evaluate()).firing).toHaveLength(0);
  });

  it('fires when in-window failures exceed the threshold', async () => {
    const { counter, metrics } = buildMetrics();
    const rule = new SmsFailureRule(metrics, configWith(env));
    fail(counter, 'eskiz', 1);
    await rule.evaluate(); // baseline

    fail(counter, 'eskiz', 27);

    const { firing } = await rule.evaluate();

    expect(firing).toHaveLength(1);
    expect(firing[0]).toMatchObject({
      rule: 'sms_failures',
      labels: { provider: 'eskiz' },
      title: 'SMS Failures',
      severity: AlertSeverity.CRITICAL,
    });
    expect(firing[0].values.failures_5min).toBe(27);
  });

  it('stays silent at or below the threshold', async () => {
    const { counter, metrics } = buildMetrics();
    const rule = new SmsFailureRule(metrics, configWith(env));
    fail(counter, 'eskiz', 1);
    await rule.evaluate();

    fail(counter, 'eskiz', 10);

    expect((await rule.evaluate()).firing).toHaveLength(0);
  });

  it('alerts per provider, naming the one that is actually failing', async () => {
    const { counter, metrics } = buildMetrics();
    const rule = new SmsFailureRule(metrics, configWith(env));
    fail(counter, 'eskiz', 1);
    fail(counter, 'playmobile', 1);
    await rule.evaluate();

    fail(counter, 'eskiz', 40);
    fail(counter, 'playmobile', 2);

    const { firing } = await rule.evaluate();

    expect(firing).toHaveLength(1);
    expect(firing[0].labels.provider).toBe('eskiz');
  });

  it('recovers once the failures age out of the window', async () => {
    jest.useFakeTimers();
    try {
      const { counter, metrics } = buildMetrics();
      const rule = new SmsFailureRule(metrics, configWith(env));
      fail(counter, 'eskiz', 1);
      await rule.evaluate();

      fail(counter, 'eskiz', 30);
      expect((await rule.evaluate()).firing).toHaveLength(1);

      // Advance past the window with no new failures. The burst is now outside
      // it, so the in-window increase is 0 — a cumulative read would stay
      // stuck at 31 forever and never resolve.
      jest.advanceTimersByTime(6 * 60 * 1000);
      await rule.evaluate();

      jest.advanceTimersByTime(6 * 60 * 1000);
      expect((await rule.evaluate()).firing).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('BackendHealthRule', () => {
  const healthyPrisma = () =>
    ({
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    }) as unknown as PrismaService;

  const healthyRedis = () =>
    ({
      getClient: () => ({ ping: jest.fn().mockResolvedValue('PONG') }),
    }) as unknown as RedisService;

  it('reports nothing when both dependencies are reachable', async () => {
    const rule = new BackendHealthRule(
      healthyPrisma(),
      healthyRedis(),
      configWith(),
    );

    expect((await rule.evaluate()).firing).toHaveLength(0);
  });

  it('fires a critical alert when the database is unreachable', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as PrismaService;
    const rule = new BackendHealthRule(prisma, healthyRedis(), configWith());

    const { firing } = await rule.evaluate();

    expect(firing).toHaveLength(1);
    expect(firing[0]).toMatchObject({
      rule: 'backend_health',
      labels: { component: 'database' },
      title: 'Database Unreachable',
      severity: AlertSeverity.CRITICAL,
    });
  });

  it('fires a critical alert when Redis is unreachable', async () => {
    const redis = {
      getClient: () => ({
        ping: jest.fn().mockRejectedValue(new Error('connection lost')),
      }),
    } as unknown as RedisService;
    const rule = new BackendHealthRule(healthyPrisma(), redis, configWith());

    const { firing } = await rule.evaluate();

    expect(firing[0].labels.component).toBe('redis');
  });

  it('reports both independently when both are down', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('down')),
    } as unknown as PrismaService;
    const redis = {
      getClient: () => ({
        ping: jest.fn().mockRejectedValue(new Error('down')),
      }),
    } as unknown as RedisService;

    const { firing } = await new BackendHealthRule(
      prisma,
      redis,
      configWith(),
    ).evaluate();

    expect(firing.map((f) => f.labels.component).sort()).toEqual([
      'database',
      'redis',
    ]);
  });

  it('treats a hung probe as down rather than hanging the evaluation', async () => {
    // Without the timeout, a hung TCP connection would stall the whole
    // evaluation — the monitoring equivalent of the failure it reports.
    const prisma = {
      $queryRaw: jest.fn().mockReturnValue(new Promise(() => {})),
    } as unknown as PrismaService;
    const rule = new BackendHealthRule(
      prisma,
      healthyRedis(),
      configWith({ ALERT_HEALTH_TIMEOUT_MS: '20' }),
    );

    const { firing } = await rule.evaluate();

    expect(firing).toHaveLength(1);
    expect(firing[0].labels.component).toBe('database');
  });
});

describe('truncate', () => {
  it('leaves short strings untouched', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('caps long strings with an ellipsis', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});
