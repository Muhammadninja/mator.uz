import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  AlertNotifierService,
  ALERT_JOB_NAME,
  notificationJobId,
  type AlertDeliveryJob,
} from './alert-notifier.service';
import { AlertScheduler } from './alert.scheduler';
import type { AlertEvaluatorService } from './alert-evaluator.service';
import {
  ALERT_STATE,
  AlertSeverity,
  type AlertChannel,
  type AlertNotification,
} from './alerting.types';

/**
 * Requirement: delivery must never block alert evaluation, failed sends must be
 * retried by the queue, and every configured channel must get its own job. These
 * tests assert the producer side of that — the evaluator's cost is one enqueue
 * per channel, and it never throws.
 */

function configWith(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

const SOURCE = {
  version: '2.8.14',
  commit: '81e6fd3',
  host: 'backend-02',
  instance: 'worker-3',
  pid: 4242,
};

function notification(
  over: Partial<AlertNotification> = {},
): AlertNotification {
  return {
    dedupeKey: 'queue_backlog{queue="sms"}',
    fingerprint: 'A7F91B',
    state: ALERT_STATE.ACTIVE,
    rule: 'queue_backlog',
    severity: AlertSeverity.ERROR,
    labels: { queue: 'sms' },
    values: { waiting: 150, threshold: 100 },
    title: 'Sms Queue Backlog',
    summary: 'sms queue backlog',
    source: SOURCE,
    firedAt: 1_700_000_000_000,
    ...over,
  };
}

/** A channel stub with configurable name, readiness and severity floor. */
function stubChannel(
  name: string,
  configured = true,
  minSeverity = AlertSeverity.WARNING,
): AlertChannel {
  return {
    name,
    configured,
    accepts: (n: AlertNotification) => n.severity >= minSeverity,
    deliver: jest.fn().mockResolvedValue(undefined),
  };
}

function stubQueue(): jest.Mocked<Queue<AlertDeliveryJob>> {
  return {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  } as unknown as jest.Mocked<Queue<AlertDeliveryJob>>;
}

describe('AlertNotifierService', () => {
  it('enqueues instead of sending inline', async () => {
    const telegram = stubChannel('telegram');
    const queue = stubQueue();
    const notifier = new AlertNotifierService([telegram], configWith(), queue);

    await notifier.notify(notification());

    expect(queue.add).toHaveBeenCalledTimes(1);
    // The evaluator must never wait on a third-party HTTPS round trip.
    expect(telegram.deliver).not.toHaveBeenCalled();
  });

  it('fans out one job per accepting channel', async () => {
    // Separate jobs, so a failing Slack webhook never re-sends the Telegram
    // message that already succeeded.
    const queue = stubQueue();
    const notifier = new AlertNotifierService(
      [stubChannel('telegram'), stubChannel('slack'), stubChannel('discord')],
      configWith(),
      queue,
    );

    await notifier.notify(notification());

    expect(queue.add).toHaveBeenCalledTimes(3);
    const channels = queue.add.mock.calls.map((call) => call[1].channel);
    expect(channels.sort()).toEqual(['discord', 'slack', 'telegram']);
  });

  it('skips channels that are not configured', async () => {
    const queue = stubQueue();
    const notifier = new AlertNotifierService(
      [stubChannel('telegram'), stubChannel('slack', false)],
      configWith(),
      queue,
    );

    await notifier.notify(notification());

    // Queueing jobs guaranteed to fail every retry would just fill the failed
    // set with noise.
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1].channel).toBe('telegram');
  });

  it("honours each channel's minimum severity", async () => {
    const queue = stubQueue();
    const notifier = new AlertNotifierService(
      [
        stubChannel('telegram', true, AlertSeverity.INFO),
        // PagerDuty-style: only wake someone for a real outage.
        stubChannel('pagerduty', true, AlertSeverity.CRITICAL),
      ],
      configWith(),
      queue,
    );

    await notifier.notify(notification({ severity: AlertSeverity.WARNING }));

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1].channel).toBe('telegram');
  });

  it('applies the configured retry policy to each delivery job', async () => {
    const queue = stubQueue();
    const notifier = new AlertNotifierService(
      [stubChannel('telegram')],
      configWith({
        ALERT_DELIVERY_ATTEMPTS: '7',
        ALERT_DELIVERY_BACKOFF_MS: '2500',
      }),
      queue,
    );

    await notifier.notify(notification());

    expect(queue.add).toHaveBeenCalledWith(
      ALERT_JOB_NAME,
      expect.any(Object),
      expect.objectContaining({
        attempts: 7,
        backoff: { type: 'exponential', delay: 2500 },
      }),
    );
  });

  it('logs only when no channel accepts the alert', async () => {
    const queue = stubQueue();
    const notifier = new AlertNotifierService(
      [stubChannel('telegram', false)],
      configWith(),
      queue,
    );

    await notifier.notify(notification());

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('never throws when the enqueue itself fails', async () => {
    const queue = stubQueue();
    queue.add.mockRejectedValue(new Error('redis down'));
    const notifier = new AlertNotifierService(
      [stubChannel('telegram')],
      configWith(),
      queue,
    );

    // A delivery-side failure must not abort the remaining rules.
    await expect(notifier.notify(notification())).resolves.toBeUndefined();
  });

  it('delivers inline when no queue is wired, and swallows failures', async () => {
    const telegram = stubChannel('telegram');
    (telegram.deliver as jest.Mock).mockRejectedValue(
      new Error('telegram 500'),
    );
    const notifier = new AlertNotifierService([telegram], configWith());

    await expect(notifier.notify(notification())).resolves.toBeUndefined();
    expect(telegram.deliver).toHaveBeenCalled();
  });
});

describe('notificationJobId', () => {
  it('collapses a duplicate announcement of the same transition', () => {
    expect(notificationJobId(notification(), 'telegram')).toBe(
      notificationJobId(notification(), 'telegram'),
    );
  });

  it('keeps the same alert on different channels distinct', () => {
    // Otherwise a Slack failure would deduplicate against the Telegram job.
    expect(notificationJobId(notification(), 'telegram')).not.toBe(
      notificationJobId(notification(), 'slack'),
    );
  });

  it('keeps ACTIVE and RESOLVED as distinct deliveries', () => {
    expect(notificationJobId(notification(), 'telegram')).not.toBe(
      notificationJobId(
        notification({ state: ALERT_STATE.RESOLVED }),
        'telegram',
      ),
    );
  });

  it('keeps a later re-notification distinct from the first', () => {
    expect(
      notificationJobId(notification({ firedAt: 1 }), 'telegram'),
    ).not.toBe(notificationJobId(notification({ firedAt: 2 }), 'telegram'));
  });

  // BullMQ rejects a custom jobId containing ':' (unless it splits into exactly
  // 3 parts), so an id with one would make every alert delivery fail to enqueue.
  // dedupeKey embeds rendered label VALUES, which are not colon-free by
  // construction — hence the explicit colon-bearing label here.
  it('never contains ":" even when a label value does', () => {
    const id = notificationJobId(
      notification({
        dedupeKey: 'queue_backlog{queue="sms",host="redis:6379"}',
      }),
      'telegram',
    );
    expect(id).not.toContain(':');
  });
});

describe('AlertScheduler', () => {
  function stubEvaluator(): jest.Mocked<AlertEvaluatorService> {
    return {
      evaluate: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AlertEvaluatorService>;
  }

  afterEach(() => jest.useRealTimers());

  it('evaluates on the configured interval', () => {
    jest.useFakeTimers();
    const evaluator = stubEvaluator();
    const scheduler = new AlertScheduler(
      evaluator,
      configWith({ ALERTING_INTERVAL_SEC: '60' }),
    );

    scheduler.onModuleInit();
    jest.advanceTimersByTime(60_000);

    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    scheduler.onModuleDestroy();
  });

  it('does not start a timer when alerting is disabled', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const scheduler = new AlertScheduler(
      stubEvaluator(),
      configWith({ ALERTING_ENABLED: 'false' }),
    );

    scheduler.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('stops the timer on shutdown', () => {
    jest.useFakeTimers();
    const evaluator = stubEvaluator();
    const scheduler = new AlertScheduler(evaluator, configWith());

    scheduler.onModuleInit();
    scheduler.onModuleDestroy();
    jest.advanceTimersByTime(300_000);

    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous evaluation is still running', async () => {
    // A hung dependency must not pile up concurrent evaluations.
    const evaluator = stubEvaluator();
    let release!: () => void;
    evaluator.evaluate.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const scheduler = new AlertScheduler(evaluator, configWith());

    const first = scheduler.tick();
    await scheduler.tick(); // must be skipped, not queued

    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);

    release();
    await first;

    // Once the first run finishes the guard is released.
    await scheduler.tick();
    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
  });
});
