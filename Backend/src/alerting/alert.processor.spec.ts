// The alerts worker carries two kinds of job: alert deliveries (one per channel) and order
// notices. Each must reach its own handler, and the worker events must read each kind's
// own payload: an order notice has no `notification`, and reading one would throw.
import type { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { MetricsService } from '../metrics/metrics.service';
import { ALERT_JOB_NAME } from './alert-notifier.service';
import { AlertProcessor } from './alert.processor';
import {
  ALERT_STATE,
  AlertSeverity,
  type AlertChannel,
  type AlertNotification,
} from './alerting.types';
import {
  ORDER_NOTICE_JOB,
  type OrderNoticeService,
} from './orders/order-notice.service';

/** The job type the worker's handlers take. */
type QueueJob = Parameters<AlertProcessor['process']>[0];

const NOTIFICATION: AlertNotification = {
  dedupeKey: 'backend_health{component="database"}',
  fingerprint: 'A7F91B',
  state: ALERT_STATE.ACTIVE,
  rule: 'backend_health',
  severity: AlertSeverity.CRITICAL,
  labels: { component: 'database' },
  values: { status: 'unreachable' },
  title: 'Database Unreachable',
  summary: 'Database connectivity',
  links: {},
  source: { version: '1', commit: '', host: 'h', instance: '', pid: 1 },
  firedAt: 0,
};

function setup() {
  const channelDeliver = jest.fn().mockResolvedValue(undefined);
  const telegram: AlertChannel = {
    name: 'telegram',
    configured: true,
    accepts: () => true,
    deliver: channelDeliver,
  };
  const orderNotices = { deliver: jest.fn().mockResolvedValue(undefined) };
  const metrics = { observeJob: jest.fn() };
  const processor = new AlertProcessor(
    [telegram],
    orderNotices as unknown as OrderNoticeService,
    metrics as unknown as MetricsService,
  );
  const { logger } = processor as unknown as { logger: Logger };
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  return { processor, channelDeliver, orderNotices, metrics, warn, error, log };
}

const orderJob = (over: Record<string, unknown> = {}): QueueJob =>
  ({
    id: 'order-notice_placed_ord_1',
    name: ORDER_NOTICE_JOB,
    data: { orderId: 'ord_1', trigger: 'placed' },
    opts: { attempts: 10 },
    attemptsMade: 1,
    discard: jest.fn(),
    ...over,
  }) as unknown as QueueJob;

const alertJob = (over: Record<string, unknown> = {}): QueueJob =>
  ({
    id: 'alert_telegram_x',
    name: ALERT_JOB_NAME,
    data: { channel: 'telegram', notification: NOTIFICATION },
    opts: { attempts: 5 },
    attemptsMade: 1,
    discard: jest.fn(),
    ...over,
  }) as unknown as QueueJob;

describe('AlertProcessor', () => {
  it('hands an order notice to OrderNoticeService, not to a channel', async () => {
    const { processor, channelDeliver, orderNotices } = setup();

    await processor.process(orderJob());

    expect(orderNotices.deliver).toHaveBeenCalledWith({
      orderId: 'ord_1',
      trigger: 'placed',
    });
    expect(channelDeliver).not.toHaveBeenCalled();
  });

  it('lets an order notice failure propagate, so BullMQ retries', async () => {
    const { processor, orderNotices } = setup();
    orderNotices.deliver.mockRejectedValue(new Error('socket hang up'));

    await expect(processor.process(orderJob())).rejects.toThrow(
      'socket hang up',
    );
  });

  it('still delivers an alert through its channel', async () => {
    const { processor, channelDeliver, orderNotices } = setup();

    await processor.process(alertJob());

    expect(channelDeliver).toHaveBeenCalledWith(NOTIFICATION);
    expect(orderNotices.deliver).not.toHaveBeenCalled();
  });

  it('completes either kind without reading the other kind’s payload', () => {
    const { processor, metrics, log } = setup();

    expect(() => processor.onCompleted(orderJob())).not.toThrow();
    expect(() => processor.onCompleted(alertJob())).not.toThrow();

    expect(metrics.observeJob).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('[A7F91B] Alert notification sent');
  });

  it('warns on an order notice attempt that will be retried', () => {
    const { processor, warn, error, metrics } = setup();

    processor.onFailed(orderJob({ attemptsMade: 3 }), new Error('timeout'));

    expect(warn).toHaveBeenCalledWith(
      'Order ord_1: placed notice attempt 3/10 failed: timeout — retrying',
    );
    expect(error).not.toHaveBeenCalled();
    expect(metrics.observeJob).not.toHaveBeenCalled();
  });

  it('reports an order notice as failed for good once retrying cannot help', () => {
    const { processor, warn, error, metrics } = setup();

    processor.onFailed(
      orderJob({ attemptsMade: 1 }),
      new UnrecoverableError('Telegram refused it: 403'),
    );
    processor.onFailed(orderJob({ attemptsMade: 10 }), new Error('timeout'));

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0][0]).toContain(
      'Order ord_1: placed notice FAILED permanently after 1 attempt(s)',
    );
    expect(metrics.observeJob).toHaveBeenCalledTimes(2);
  });

  it('keeps reporting alert delivery failures as before', () => {
    const { processor, warn, error } = setup();

    processor.onFailed(alertJob({ attemptsMade: 2 }), new Error('boom'));
    processor.onFailed(alertJob({ attemptsMade: 5 }), new Error('boom'));
    processor.onFailed(undefined, new Error('boom'));

    expect(warn).toHaveBeenCalledWith(
      '[A7F91B] Alert "backend_health{component="database"}" via telegram attempt 2/5 failed: boom — retrying',
    );
    expect(error).toHaveBeenCalledTimes(2);
  });
});
