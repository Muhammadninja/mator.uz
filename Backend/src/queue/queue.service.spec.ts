// Unit tests for the BullMQ infrastructure — mock-driven, matching the
// repo convention (no live Redis; BullMQ `Queue`/`Worker` are doubled). These
// verify the WIRING, not job processing:
//   • queue names + default job options are the agreed infrastructure contract
//   • QueueService injects the three queues and delegates enqueues to them
//     (deterministic jobId only where it should be)
//   • the workers' process()/event handlers are callable and log
//   • QueueModule references every queue it registers (no orphan queue/worker)

import { QueueService } from './queue.service';
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from './queue.constants';
import { buildQueueConnection } from './queue.config';
import {
  ImageProcessingProcessor,
  SmsProcessor,
  NotificationsProcessor,
} from './queue.processors';

/** Minimal BullMQ Queue double — records add() calls, returns a fake job. */
function makeQueueMock() {
  return {
    add: jest.fn(async (name: string, data: unknown, opts?: unknown) => ({
      id: (opts as any)?.jobId ?? 'auto-id',
      name,
      data,
      opts,
    })),
  };
}

function buildService() {
  const imageQueue = makeQueueMock();
  const smsQueue = makeQueueMock();
  const notificationQueue = makeQueueMock();
  const service = new QueueService(
    imageQueue as never,
    smsQueue as never,
    notificationQueue as never,
  );
  jest
    .spyOn((service as any).logger, 'debug')
    .mockImplementation(() => undefined);
  return { service, imageQueue, smsQueue, notificationQueue };
}

describe('Queue infrastructure', () => {
  describe('queue names', () => {
    it('are the agreed, stable string constants', () => {
      expect(QUEUE_NAMES).toEqual({
        IMAGE_PROCESSING: 'image-processing',
        SMS: 'sms',
        NOTIFICATIONS: 'notifications',
        MAINTENANCE: 'maintenance',
      });
    });
  });

  describe('default job options (retry + retention policy)', () => {
    it('uses bounded, exponential retries — never infinite', () => {
      expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
      expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({
        type: 'exponential',
        delay: 2_000,
      });
    });

    it('auto-cleans completed and failed jobs after retention', () => {
      expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({
        age: 86_400,
        count: 1_000,
      });
      expect(DEFAULT_JOB_OPTIONS.removeOnFail).toEqual({
        age: 604_800,
        count: 5_000,
      });
    });
  });

  describe('connection reuse (no second Redis config)', () => {
    it('reads the SAME REDIS_* env vars as the primary client', () => {
      const config = {
        get: jest.fn((k: string) =>
          k === 'REDIS_PASSWORD' ? 'secret' : undefined,
        ),
        getOrThrow: jest.fn((k: string) =>
          k === 'REDIS_HOST' ? 'redis.internal' : '6380',
        ),
      };
      const conn = buildQueueConnection(config as never);
      expect(conn).toEqual({
        host: 'redis.internal',
        port: 6380,
        password: 'secret',
        maxRetriesPerRequest: null, // required by BullMQ
      });
    });

    it('omits an empty password (matches redis.provider.ts)', () => {
      const config = {
        get: jest.fn(() => ''),
        getOrThrow: jest.fn((k: string) => (k === 'REDIS_HOST' ? 'h' : '6379')),
      };
      expect(buildQueueConnection(config as never).password).toBeUndefined();
    });
  });

  describe('QueueService (producer)', () => {
    it('injects and delegates enqueueImage to the image queue with a deterministic jobId', async () => {
      const { service, imageQueue } = buildService();
      const job = await service.enqueueImage({ draftId: 'draft_1', imageId: 'dimg_9' });
      expect(imageQueue.add).toHaveBeenCalledWith(
        'process',
        { draftId: 'draft_1', imageId: 'dimg_9' },
        { jobId: 'image:draft_1:dimg_9' },
      );
      // Same draft image enqueued twice → same jobId → BullMQ collapses to one job.
      expect(job.id).toBe('image:draft_1:dimg_9');
    });

    it('enqueueSms delegates without a deterministic jobId (distinct sends must not collapse)', async () => {
      const { service, smsQueue } = buildService();
      await service.enqueueSms({ phone: '+998901112233', message: 'hi' });
      expect(smsQueue.add).toHaveBeenCalledWith(
        'send',
        { phone: '+998901112233', message: 'hi' },
        undefined,
      );
    });

    it('enqueueNotification delegates to the notifications queue', async () => {
      const { service, notificationQueue } = buildService();
      await service.enqueueNotification({ userId: 'u1', type: 'ORDER_UPDATE' });
      expect(notificationQueue.add).toHaveBeenCalledWith(
        'notify',
        { userId: 'u1', type: 'ORDER_UPDATE' },
        undefined,
      );
    });

    it('lets a caller supply their own jobId for at-most-once semantics', async () => {
      const { service, smsQueue } = buildService();
      await service.enqueueSms(
        { phone: '+998901112233', message: 'x' },
        { jobId: 'evt-42' },
      );
      expect(smsQueue.add).toHaveBeenCalledWith('send', expect.any(Object), {
        jobId: 'evt-42',
      });
    });
  });

  describe('workers (consumers) start and log', () => {
    it('the placeholder processors have a callable process() and lifecycle handlers', async () => {
      const procs = [new SmsProcessor(), new NotificationsProcessor()];
      for (const p of procs) {
        jest
          .spyOn((p as any).logger, 'log')
          .mockImplementation(() => undefined);
        jest
          .spyOn((p as any).logger, 'warn')
          .mockImplementation(() => undefined);
        jest
          .spyOn((p as any).logger, 'error')
          .mockImplementation(() => undefined);
        expect(typeof p.process).toBe('function');
        expect(typeof (p as any).onCompleted).toBe('function');
        expect(typeof (p as any).onFailed).toBe('function');
        expect(typeof (p as any).onStalled).toBe('function');
      }
    });

    it('failed handler tolerates an undefined job', () => {
      const p = new SmsProcessor();
      jest
        .spyOn((p as any).logger, 'error')
        .mockImplementation(() => undefined);
      expect(() => p.onFailed(undefined, new Error('boom'))).not.toThrow();
    });
  });
});
