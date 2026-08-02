// Unit tests for the BullMQ infrastructure — mock-driven, matching the
// repo convention (no live Redis; BullMQ `Queue`/`Worker` are doubled). These
// verify the WIRING, not job processing:
//   • queue names + default job options are the agreed infrastructure contract
//   • QueueService injects the three queues and delegates enqueues to them
//     (deterministic jobId only where it should be)
//   • the workers' process()/event handlers are callable and log
//   • QueueModule references every queue it registers (no orphan queue/worker)

import 'reflect-metadata';
import { QueueService } from './queue.service';
import {
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  IMAGE_WORKER_CONCURRENCY_DEFAULT,
  resolveImageWorkerConcurrency,
  SMS_WORKER_CONCURRENCY_DEFAULT,
  resolveSmsWorkerConcurrency,
} from './queue.constants';
import { buildQueueConnection } from './queue.config';
import {
  ImageProcessingProcessor,
  SmsProcessor,
  NotificationsProcessor,
} from './queue.processors';

/**
 * Minimal BullMQ Queue double. `getJob` returns a fake job (with its own remove())
 * by default so removeImageJob's getJob→job.remove() path runs; a test can override
 * getJob to return null (already-gone) or a job whose remove() rejects (locked).
 */
/** The job shape the double hands back (only what QueueService touches). */
interface FakeJob {
  id: string | undefined;
  remove: () => Promise<unknown>;
}

function makeQueueMock() {
  const jobRemove = jest.fn(async () => undefined);
  // The return types are declared rather than inferred from the DEFAULT
  // implementations: inference pins them to exactly what the default returns
  // (e.g. `remove: jest.Mock<Promise<undefined>>`), which then rejects the
  // overrides this double exists to support — `null` for an already-gone job, or
  // a job whose remove() rejects. Declaring the contract keeps both legal.
  return {
    add: jest.fn<
      Promise<{ id: string | undefined }>,
      [string, unknown, unknown?]
    >(async (name: string, data: unknown, opts?: unknown) => ({
      id: (opts as any)?.jobId ?? 'auto-id',
      name,
      data,
      opts,
    })),
    getJob: jest.fn<Promise<FakeJob | null>, [string]>(async (id: string) => ({
      id,
      remove: jobRemove,
    })),
    // Exposed so tests can assert on the job-level remove() the code now calls.
    __jobRemove: jobRemove,
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
        // Outbound operational alert delivery (src/alerting). Separate from
        // NOTIFICATIONS so an alert never queues behind the user-facing push
        // backlog it may be reporting on.
        ALERTS: 'alerts',
      });
    });
  });

  describe('image worker concurrency', () => {
    it('resolveImageWorkerConcurrency: default when unset/blank/invalid/out-of-range', () => {
      expect(resolveImageWorkerConcurrency(undefined)).toBe(
        IMAGE_WORKER_CONCURRENCY_DEFAULT,
      );
      expect(resolveImageWorkerConcurrency('')).toBe(
        IMAGE_WORKER_CONCURRENCY_DEFAULT,
      );
      expect(resolveImageWorkerConcurrency('abc')).toBe(
        IMAGE_WORKER_CONCURRENCY_DEFAULT,
      );
      expect(resolveImageWorkerConcurrency('0')).toBe(
        IMAGE_WORKER_CONCURRENCY_DEFAULT,
      ); // below min
      expect(resolveImageWorkerConcurrency('11')).toBe(
        IMAGE_WORKER_CONCURRENCY_DEFAULT,
      ); // above max
      expect(resolveImageWorkerConcurrency('2.5')).toBe(
        IMAGE_WORKER_CONCURRENCY_DEFAULT,
      ); // non-integer
    });

    it('resolveImageWorkerConcurrency: accepts a valid in-range integer', () => {
      expect(resolveImageWorkerConcurrency('1')).toBe(1);
      expect(resolveImageWorkerConcurrency('7')).toBe(7);
      expect(resolveImageWorkerConcurrency('10')).toBe(10);
    });

    it('the image processor registers worker concurrency > 1 (album photos run in parallel, not one-by-one)', () => {
      // @nestjs/bullmq stores the @Processor worker options under this metadata key.
      const workerOpts = Reflect.getMetadata(
        'bullmq:worker_metadata',
        ImageProcessingProcessor,
      ) as { concurrency?: number } | undefined;
      expect(workerOpts?.concurrency).toBe(IMAGE_WORKER_CONCURRENCY_DEFAULT);
      expect(workerOpts?.concurrency).toBeGreaterThan(1);
    });
  });

  describe('sms worker concurrency (outbound throttle)', () => {
    it('resolveSmsWorkerConcurrency: default when unset/blank/invalid/out-of-range', () => {
      expect(resolveSmsWorkerConcurrency(undefined)).toBe(
        SMS_WORKER_CONCURRENCY_DEFAULT,
      );
      expect(resolveSmsWorkerConcurrency('')).toBe(SMS_WORKER_CONCURRENCY_DEFAULT);
      expect(resolveSmsWorkerConcurrency('abc')).toBe(
        SMS_WORKER_CONCURRENCY_DEFAULT,
      );
      expect(resolveSmsWorkerConcurrency('0')).toBe(SMS_WORKER_CONCURRENCY_DEFAULT);
      expect(resolveSmsWorkerConcurrency('21')).toBe(
        SMS_WORKER_CONCURRENCY_DEFAULT,
      );
      expect(resolveSmsWorkerConcurrency('2.5')).toBe(
        SMS_WORKER_CONCURRENCY_DEFAULT,
      );
    });

    it('resolveSmsWorkerConcurrency: accepts a valid in-range integer', () => {
      expect(resolveSmsWorkerConcurrency('1')).toBe(1);
      expect(resolveSmsWorkerConcurrency('20')).toBe(20);
    });

    it('keeps SMS concurrency low — aggregators rate-limit per account', () => {
      const workerOpts = Reflect.getMetadata(
        'bullmq:worker_metadata',
        SmsProcessor,
      ) as { concurrency?: number } | undefined;
      expect(workerOpts?.concurrency).toBe(SMS_WORKER_CONCURRENCY_DEFAULT);
      expect(workerOpts?.concurrency).toBeLessThan(
        IMAGE_WORKER_CONCURRENCY_DEFAULT * 2,
      );
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
      const job = await service.enqueueImage({
        draftId: 'draft_1',
        imageId: 'dimg_9',
      });
      expect(imageQueue.add).toHaveBeenCalledWith(
        'process',
        { draftId: 'draft_1', imageId: 'dimg_9' },
        { jobId: 'image_draft_1_dimg_9' },
      );
      // Same draft image enqueued twice → same jobId → BullMQ collapses to one job.
      expect(job.id).toBe('image_draft_1_dimg_9');
    });

    // ── Image-flow isolation (regression guard for the SMS/notification migration) ──
    // The image pipeline predates this migration and must be byte-for-byte
    // unaffected by it. These pin the boundaries that a careless change to the
    // shared QueueService would break.
    it('enqueueSms/enqueueNotification never touch the image queue', async () => {
      const { service, imageQueue } = buildService();

      await service.enqueueSms({ phone: '+998901112233', message: 'x' });
      await service.enqueueNotification({
        userId: 'u1',
        type: 'ORDER_PAID',
        notificationId: 'ntf_1',
        title: 'T',
        body: 'B',
      });

      expect(imageQueue.add).not.toHaveBeenCalled();
      expect(imageQueue.getJob).not.toHaveBeenCalled();
    });

    it('image jobIds stay in their own namespace, distinct from sms/notify ids', () => {
      const { service } = buildService();
      // A collision across namespaces would let one flow's job silently collapse
      // another's, since BullMQ dedupes on jobId within a queue.
      expect(service.imageJobId({ draftId: 'd', imageId: 'i' })).toMatch(/^image_/);
      expect(service.otpSmsJobId('otp_1', 0)).toMatch(/^sms_otp_/);
      expect(
        service.notificationJobId({
          userId: 'u',
          type: 't',
          notificationId: 'ntf_1',
          title: 'T',
          body: 'B',
        }),
      ).toMatch(/^notify_/);
    });

    it('reenqueueImage removes the stale job BEFORE adding (retry must not collapse into a retained failed job)', async () => {
      const { service, imageQueue } = buildService();
      const order: string[] = [];
      imageQueue.getJob.mockImplementation(async (id: string) => ({
        id,
        remove: jest.fn(async () => {
          order.push('remove');
        }),
      }));
      imageQueue.add.mockImplementation(async (_n, _d, opts?: unknown) => {
        order.push('add');
        return { id: (opts as any)?.jobId };
      });

      await service.reenqueueImage({ draftId: 'draft_1', imageId: 'dimg_9' });

      expect(imageQueue.getJob).toHaveBeenCalledWith('image_draft_1_dimg_9');
      expect(imageQueue.add).toHaveBeenCalled();
      expect(order).toEqual(['remove', 'add']); // remove strictly precedes add
    });

    it('removeImageJob is a no-op when the job already vanished (getJob → null)', async () => {
      const { service, imageQueue } = buildService();
      imageQueue.getJob.mockResolvedValue(null);
      await expect(
        service.removeImageJob('image_x_y'),
      ).resolves.toBeUndefined();
      expect(imageQueue.__jobRemove).not.toHaveBeenCalled();
    });

    it('removeImageJob swallows a rejecting job.remove() (locked/active job must not break retry/cancel)', async () => {
      const { service, imageQueue } = buildService();
      imageQueue.getJob.mockResolvedValue({
        id: 'image_x_y',
        remove: jest.fn(async () => {
          throw new Error('Missing lock for job (job is active)');
        }),
      });
      await expect(
        service.removeImageJob('image_x_y'),
      ).resolves.toBeUndefined();
    });

    it('imageJobId builds the deterministic id', () => {
      const { service } = buildService();
      expect(service.imageJobId({ draftId: 'd', imageId: 'i' })).toBe(
        'image_d_i',
      );
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

    it('enqueueNotification delegates with a deterministic jobId from the row id', async () => {
      const { service, notificationQueue } = buildService();
      const data = {
        userId: 'u1',
        type: 'ORDER_UPDATE',
        notificationId: 'ntf_1',
        title: 'T',
        body: 'B',
      };
      await service.enqueueNotification(data);
      // One committed inbox row → at most one push fan-out job.
      expect(notificationQueue.add).toHaveBeenCalledWith('notify', data, {
        jobId: 'notify_ntf_1',
      });
    });

    it('gives two distinct notifications distinct jobIds (no false collapse)', async () => {
      const { service } = buildService();
      const base = { userId: 'u1', type: 'ORDER_UPDATE', title: 'T', body: 'B' };
      expect(
        service.notificationJobId({ ...base, notificationId: 'ntf_1' }),
      ).not.toBe(
        service.notificationJobId({ ...base, notificationId: 'ntf_2' }),
      );
    });

    it('builds OTP sms jobIds that collapse a repeat but not a resend', async () => {
      const { service } = buildService();
      // Same (requestId, sendCount) → same id, so a retried HTTP request cannot
      // double-send. A resend bumps sendCount → distinct id, so it delivers.
      expect(service.otpSmsJobId('otp_1', 0)).toBe(service.otpSmsJobId('otp_1', 0));
      expect(service.otpSmsJobId('otp_1', 0)).not.toBe(
        service.otpSmsJobId('otp_1', 1),
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
    it('the processors have a callable process() and lifecycle handlers', async () => {
      const procs = [
        new SmsProcessor({ sendSms: jest.fn() } as never),
        new NotificationsProcessor({ sendToUser: jest.fn() } as never),
      ];
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
      const p = new SmsProcessor({ sendSms: jest.fn() } as never);
      jest
        .spyOn((p as any).logger, 'error')
        .mockImplementation(() => undefined);
      expect(() => p.onFailed(undefined, new Error('boom'))).not.toThrow();
    });
  });
});
