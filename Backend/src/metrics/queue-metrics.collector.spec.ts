import type { Queue } from 'bullmq';
import type { MetricsConfig } from './metrics.config';
import { DEFAULT_METRICS_PREFIX } from './metrics.config';
import { QueueMetricsCollector } from './queue-metrics.collector';
import type { MetricsService } from './metrics.service';
import { jobDurationSeconds } from './job-duration.util';

function config(overrides: Partial<MetricsConfig> = {}): MetricsConfig {
  return {
    enabled: true,
    path: '/metrics',
    prefix: DEFAULT_METRICS_PREFIX,
    queueMetricsEnabled: true,
    smsCostMetricsEnabled: true,
    ...overrides,
  };
}

function metricsDouble() {
  return {
    setQueueDepths: jest.fn(),
    setQueueWorkers: jest.fn(),
  } as unknown as MetricsService & {
    setQueueDepths: jest.Mock;
    setQueueWorkers: jest.Mock;
  };
}

function okQueue(counts: Record<string, number>, workers = 2): Queue {
  return {
    getJobCounts: jest.fn().mockResolvedValue(counts),
    getWorkers: jest.fn().mockResolvedValue(new Array(workers).fill({})),
  } as unknown as Queue;
}

function failingQueue(message = 'redis down'): Queue {
  return {
    getJobCounts: jest.fn().mockRejectedValue(new Error(message)),
    getWorkers: jest.fn().mockRejectedValue(new Error(message)),
  } as unknown as Queue;
}

describe('QueueMetricsCollector', () => {
  it('publishes depths and worker counts for every injected queue', async () => {
    const metrics = metricsDouble();
    const image = okQueue({ waiting: 3, active: 1, failed: 0 }, 5);
    const sms = okQueue({ waiting: 0, active: 0 }, 1);

    const collector = new QueueMetricsCollector(
      metrics,
      config(),
      image,
      sms,
      undefined,
      undefined,
    );
    await collector.collect();

    expect(metrics.setQueueDepths).toHaveBeenCalledWith('image-processing', {
      waiting: 3,
      active: 1,
      failed: 0,
    });
    expect(metrics.setQueueWorkers).toHaveBeenCalledWith('image-processing', 5);
    expect(metrics.setQueueDepths).toHaveBeenCalledWith('sms', {
      waiting: 0,
      active: 0,
    });
    expect(metrics.setQueueWorkers).toHaveBeenCalledWith('sms', 1);
  });

  it('uses getJobCounts (one Redis call) and never enumerates jobs', async () => {
    const metrics = metricsDouble();
    // Enumerating jobs would be O(queue depth) per scrape and could pull tens of
    // thousands of payloads into memory every 15 seconds. Fail loudly if any
    // job-listing API is ever reached for.
    const forbidden = {
      getJobs: jest.fn(() => {
        throw new Error('getJobs must not be used for metrics');
      }),
      getWaiting: jest.fn(() => {
        throw new Error('getWaiting must not be used for metrics');
      }),
      getActive: jest.fn(() => {
        throw new Error('getActive must not be used for metrics');
      }),
      getFailed: jest.fn(() => {
        throw new Error('getFailed must not be used for metrics');
      }),
    };
    const queue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 5, active: 1 }),
      getWorkers: jest.fn().mockResolvedValue([{}]),
      ...forbidden,
    } as unknown as Queue;

    const collector = new QueueMetricsCollector(metrics, config(), queue);
    await collector.collect();

    // Exactly one counts call per scrape, and no enumeration.
    expect(queue.getJobCounts).toHaveBeenCalledTimes(1);
    expect(forbidden.getJobs).not.toHaveBeenCalled();
    expect(forbidden.getWaiting).not.toHaveBeenCalled();
    expect(forbidden.getActive).not.toHaveBeenCalled();
    expect(forbidden.getFailed).not.toHaveBeenCalled();
    // The counts still landed, so the collector genuinely did its job.
    expect(metrics.setQueueDepths).toHaveBeenCalledWith('image-processing', {
      waiting: 5,
      active: 1,
    });
  });

  it('is read-only: it never mutates a queue', async () => {
    const metrics = metricsDouble();
    const queue = okQueue({ waiting: 1 });
    const collector = new QueueMetricsCollector(metrics, config(), queue);

    await collector.collect();

    // Only the two read calls exist on the double; anything else would have
    // thrown. Assert explicitly that no mutating API was reached for.
    const q = queue as unknown as Record<string, unknown>;
    expect(q.add).toBeUndefined();
    expect(q.drain).toBeUndefined();
    expect(q.obliterate).toBeUndefined();
    expect(queue.getJobCounts).toHaveBeenCalledTimes(1);
  });

  it('samples every queue even when one fails, and never rejects', async () => {
    const metrics = metricsDouble();
    const broken = failingQueue();
    const healthy = okQueue({ waiting: 7 }, 3);

    const collector = new QueueMetricsCollector(
      metrics,
      config(),
      broken,
      healthy,
    );

    // A Redis hiccup during a scrape must still return the other metrics.
    await expect(collector.collect()).resolves.toBeUndefined();
    expect(metrics.setQueueDepths).toHaveBeenCalledWith('sms', { waiting: 7 });
    expect(metrics.setQueueDepths).not.toHaveBeenCalledWith(
      'image-processing',
      expect.anything(),
    );
  });

  it('does nothing when metrics are disabled', async () => {
    const metrics = metricsDouble();
    const queue = okQueue({ waiting: 1 });
    const collector = new QueueMetricsCollector(
      metrics,
      config({ enabled: false }),
      queue,
    );

    await collector.collect();

    expect(queue.getJobCounts).not.toHaveBeenCalled();
    expect(metrics.setQueueDepths).not.toHaveBeenCalled();
  });

  it('does nothing when only queue metrics are disabled', async () => {
    const metrics = metricsDouble();
    const queue = okQueue({ waiting: 1 });
    const collector = new QueueMetricsCollector(
      metrics,
      config({ queueMetricsEnabled: false }),
      queue,
    );

    await collector.collect();

    expect(queue.getJobCounts).not.toHaveBeenCalled();
  });

  it('tolerates a deployment with no queues registered at all', async () => {
    const collector = new QueueMetricsCollector(metricsDouble(), config());
    await expect(collector.collect()).resolves.toBeUndefined();
  });
});

describe('jobDurationSeconds', () => {
  it('measures from BullMQ timestamps the job already carries', () => {
    expect(jobDurationSeconds({ processedOn: 1_000, finishedOn: 3_500 })).toBe(
      2.5,
    );
  });

  it('measures WORKER time only — queue waiting time is excluded', () => {
    // A job created long before a worker picked it up: enqueued at t=0, picked
    // up at t=60s, finished at t=62s. The histogram must report 2s of
    // processing, NOT 62s of "waiting + processing" — otherwise a queue backlog
    // would masquerade as a slow worker and send anyone debugging it the wrong
    // way. This is why the helper reads processedOn and never timestamp/createdAt.
    const job = {
      timestamp: 0, // BullMQ's enqueue time — deliberately ignored
      processedOn: 60_000,
      finishedOn: 62_000,
    } as { processedOn: number; finishedOn: number };

    expect(jobDurationSeconds(job)).toBe(2);
  });

  it('falls back to now when finishedOn is not yet set', () => {
    expect(jobDurationSeconds({ processedOn: 1_000 }, 4_000)).toBe(3);
  });

  it('returns undefined rather than polluting the histogram with garbage', () => {
    expect(jobDurationSeconds(undefined)).toBeUndefined();
    expect(jobDurationSeconds({})).toBeUndefined();
    expect(jobDurationSeconds({ processedOn: null })).toBeUndefined();
    // A clock skew that implies a negative duration is dropped, not recorded.
    expect(
      jobDurationSeconds({ processedOn: 5_000, finishedOn: 1_000 }),
    ).toBeUndefined();
  });
});
