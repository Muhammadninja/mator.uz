import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { QueueMonitorService } from './queue-monitor.service';
import { AlertService } from './alert.service';
import { ALERT_TYPES, type Alert } from './alert.types';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { SAMPLED_QUEUES } from './ops.config';

interface Counts {
  waiting?: number;
  active?: number;
  failed?: number;
  delayed?: number;
}

/** A Queue double exposing only what the monitor reads. */
function queueDouble(counts: Counts = {}, workers = 1): Queue {
  return {
    getJobCounts: jest.fn().mockResolvedValue({
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    }),
    getWorkers: jest.fn().mockResolvedValue(new Array(workers).fill({})),
  } as unknown as Queue;
}

/** An idle, healthy queue — used for the three queues a test isn't exercising. */
const idle = () => queueDouble({}, 1);

function configWith(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** AlertService double capturing raised alerts without any cooldown behaviour. */
function alertsDouble() {
  const raised: Alert[] = [];
  const resolved: { type: string; queue: string }[] = [];
  const service = {
    raise: jest.fn((alert: Alert) => {
      raised.push(alert);
      return Promise.resolve(true);
    }),
    resolve: jest.fn((a: { type: string; queue: string }) => {
      resolved.push(a);
    }),
  } as unknown as AlertService;
  return { service, raised, resolved };
}

/** Build a monitor whose SMS queue is `smsQueue`; the rest are idle. */
function buildMonitor(
  smsQueue: Queue,
  env: Record<string, string> = {},
  alerts = alertsDouble(),
) {
  const monitor = new QueueMonitorService(
    configWith(env),
    alerts.service,
    idle(),
    smsQueue,
    idle(),
    idle(),
  );
  return { monitor, alerts };
}

const smsAlerts = (raised: Alert[]) =>
  raised.filter((a) => a.queue === QUEUE_NAMES.SMS);

describe('QueueMonitorService', () => {
  describe('failed job threshold', () => {
    it('alerts when failed jobs reach the threshold', async () => {
      const { monitor, alerts } = buildMonitor(queueDouble({ failed: 30 }), {
        QUEUE_ALERT_FAILED_THRESHOLD: '25',
      });

      await monitor.sweep();

      const failed = smsAlerts(alerts.raised).filter(
        (a) => a.type === ALERT_TYPES.FAILED_JOBS,
      );
      expect(failed).toHaveLength(1);
      expect(failed[0].context).toMatchObject({ failed: 30, threshold: 25 });
    });

    it('stays silent below the threshold', async () => {
      const { monitor, alerts } = buildMonitor(queueDouble({ failed: 24 }), {
        QUEUE_ALERT_FAILED_THRESHOLD: '25',
      });

      await monitor.sweep();

      expect(
        alerts.raised.filter((a) => a.type === ALERT_TYPES.FAILED_JOBS),
      ).toHaveLength(0);
    });
  });

  describe('stopped workers', () => {
    it('raises a critical alert when jobs are pending with no workers', async () => {
      const { monitor, alerts } = buildMonitor(queueDouble({ waiting: 5 }, 0));

      await monitor.sweep();

      const stalled = smsAlerts(alerts.raised).filter(
        (a) => a.type === ALERT_TYPES.NO_ACTIVE_WORKERS,
      );
      expect(stalled).toHaveLength(1);
      // This never self-heals, so it must outrank a mere backlog.
      expect(stalled[0].severity).toBe('critical');
    });

    it('does not alert for an idle queue with no workers', async () => {
      // A producer-only instance with an empty queue is a normal state.
      const { monitor, alerts } = buildMonitor(queueDouble({ waiting: 0 }, 0));

      await monitor.sweep();

      expect(
        alerts.raised.filter((a) => a.type === ALERT_TYPES.NO_ACTIVE_WORKERS),
      ).toHaveLength(0);
    });

    it('does not alert when workers are attached', async () => {
      const { monitor, alerts } = buildMonitor(
        queueDouble({ waiting: 500 }, 2),
      );

      await monitor.sweep();

      expect(
        alerts.raised.filter((a) => a.type === ALERT_TYPES.NO_ACTIVE_WORKERS),
      ).toHaveLength(0);
    });
  });

  describe('growing backlog', () => {
    const env = {
      QUEUE_ALERT_WAITING_THRESHOLD: '100',
      QUEUE_ALERT_WAITING_GROWTH_SAMPLES: '3',
    };

    /** Sweep once per supplied waiting-count, on one monitor instance. */
    async function sweepSeries(waitingSeries: number[], workers = 1) {
      const alerts = alertsDouble();
      const queue = queueDouble({}, workers);
      const { monitor } = buildMonitor(queue, env, alerts);

      for (const waiting of waitingSeries) {
        (queue.getJobCounts as jest.Mock).mockResolvedValue({
          waiting,
          active: 0,
          failed: 0,
          delayed: 0,
        });
        await monitor.sweep();
      }
      return alerts.raised.filter(
        (a) => a.type === ALERT_TYPES.WAITING_GROWING,
      );
    }

    it('alerts after N consecutive growing samples above the floor', async () => {
      // 4 samples → 3 consecutive increases, all above the 100 floor.
      const alerts = await sweepSeries([150, 200, 250, 300]);

      expect(alerts).toHaveLength(1);
      expect(alerts[0].context).toMatchObject({
        waiting: 300,
        growthStreak: 3,
      });
    });

    it('does not alert while growth stays below the absolute floor', async () => {
      // Steadily growing, but a backlog of <100 is not worth waking anyone.
      expect(await sweepSeries([10, 20, 30, 40])).toHaveLength(0);
    });

    it('does not alert on a burst that stops growing', async () => {
      // Spike then drain — the normal shape of a traffic burst.
      expect(await sweepSeries([150, 400, 380, 200])).toHaveLength(0);
    });

    it('resets the streak when the backlog dips', async () => {
      // Two up, one down, two up → never three consecutive increases.
      expect(await sweepSeries([150, 200, 180, 220, 260])).toHaveLength(0);
    });
  });

  describe('resilience', () => {
    it('alerts and keeps sampling other queues when one queue errors', async () => {
      const broken = {
        getJobCounts: jest.fn().mockRejectedValue(new Error('redis down')),
        getWorkers: jest.fn().mockResolvedValue([]),
      } as unknown as Queue;
      const { monitor, alerts } = buildMonitor(broken);

      const samples = await monitor.sweep();

      expect(
        alerts.raised.some((a) => a.type === ALERT_TYPES.MONITOR_ERROR),
      ).toBe(true);
      // The other three queues were still sampled — one bad queue is not fatal.
      expect(samples).toHaveLength(3);
    });

    it('returns a sample for every sampled queue', async () => {
      const { monitor } = buildMonitor(idle());

      const samples = await monitor.sweep();

      // SAMPLED_QUEUES, not every registered queue: the `alerts` queue is
      // deliberately outside monitoring-that-alerts, since a failure there is
      // precisely a failure to deliver alerts. See ops.config.ts.
      expect(samples.map((s) => s.queue).sort()).toEqual(
        [...SAMPLED_QUEUES].sort(),
      );
    });
  });

  it('does not start a timer when monitoring is disabled', () => {
    const { monitor } = buildMonitor(idle(), {
      QUEUE_MONITOR_ENABLED: 'false',
    });
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    monitor.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    monitor.onModuleDestroy();
  });
});
