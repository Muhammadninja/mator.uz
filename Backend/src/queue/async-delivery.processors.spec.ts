// Unit tests for the two workers migrated off the request path: SmsProcessor and
// NotificationsProcessor. Mock-driven (no live Redis, no BullMQ runtime) — these
// verify the CONSUMER contract:
//   • the processor calls its provider with exactly the job's payload
//   • a provider failure PROPAGATES, so BullMQ applies retry/backoff
//   • a retry is safe (no business state is mutated by the worker)
//   • failure handlers distinguish "retry pending" from "permanently failed"
//     and never throw (a throwing handler would crash the worker)
//
// The producer side (OTP/notifications enqueue rather than send inline) is
// covered in otp.service.spec.ts and notifications.service.spec.ts.

import 'reflect-metadata';
import { SmsProcessor, NotificationsProcessor } from './queue.processors';
import type { SmsJobData, NotificationJobData } from './queue.service';

/** Silence a processor's logger so failure-path tests don't spam output. */
function muteLogger(p: unknown): void {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest
      .spyOn((p as Record<string, any>).logger, level)
      .mockImplementation(() => undefined);
  }
}

/** A BullMQ Job double carrying just what the processors read. */
function makeJob<T>(
  data: T,
  over: { id?: string; attemptsMade?: number; attempts?: number } = {},
): any {
  return {
    id: over.id ?? 'job_1',
    data,
    attemptsMade: over.attemptsMade ?? 0,
    opts: { attempts: over.attempts ?? 3 },
  };
}

const smsJob: SmsJobData = {
  phone: '+998901234567',
  message: 'Mator: tasdiqlash kodingiz 123456.',
  template: 'otp',
};

const notifJob: NotificationJobData = {
  userId: 'usr_1',
  type: 'ORDER_PAID',
  notificationId: 'ntf_1',
  title: 'Заказ оплачен',
  body: 'Ваш заказ оплачен',
  deeplinkPath: '/orders/1',
  payload: { order_id: 'ord_1' },
};

describe('SmsProcessor — the only caller of the SMS provider', () => {
  it('sends through SmsService with the job payload', async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue(undefined) };
    const p = new SmsProcessor(sms as never);
    muteLogger(p);

    await p.process(makeJob(smsJob));

    expect(sms.sendSms).toHaveBeenCalledTimes(1);
    expect(sms.sendSms).toHaveBeenCalledWith(
      '+998901234567',
      'Mator: tasdiqlash kodingiz 123456.',
      'otp',
    );
  });

  it('passes a null template when the job carries none', async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue(undefined) };
    const p = new SmsProcessor(sms as never);
    muteLogger(p);

    await p.process(makeJob({ phone: '+998901112233', message: 'hi' }));

    expect(sms.sendSms).toHaveBeenCalledWith('+998901112233', 'hi', null);
  });

  it('PROPAGATES a provider failure so BullMQ retries with backoff', async () => {
    const sms = {
      sendSms: jest.fn().mockRejectedValue(new Error('gateway 500')),
    };
    const p = new SmsProcessor(sms as never);
    muteLogger(p);

    // Swallowing here would silently drop the SMS and mark the job complete.
    await expect(p.process(makeJob(smsJob))).rejects.toThrow('gateway 500');
  });

  it('is safe to retry: re-running the job just re-sends, touching no state', async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue(undefined) };
    const p = new SmsProcessor(sms as never);
    muteLogger(p);
    const job = makeJob(smsJob, { attemptsMade: 1 });

    await p.process(job);
    await p.process(job);

    // The worker has no other collaborators — nothing to corrupt on a retry.
    // The OTP record lives in Redis and is never written here.
    expect(sms.sendSms).toHaveBeenCalledTimes(2);
    expect(Object.keys(p as object)).not.toContain('redis');
  });

  describe('failure handling', () => {
    it('warns (not errors) while retries remain', () => {
      const p = new SmsProcessor({ sendSms: jest.fn() } as never);
      muteLogger(p);
      const warn = jest.spyOn((p as any).logger, 'warn');
      const error = jest.spyOn((p as any).logger, 'error');

      p.onFailed(makeJob(smsJob, { attemptsMade: 1, attempts: 3 }), new Error('blip'));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    });

    it('errors once retries are exhausted', () => {
      const p = new SmsProcessor({ sendSms: jest.fn() } as never);
      muteLogger(p);
      const error = jest.spyOn((p as any).logger, 'error');

      p.onFailed(makeJob(smsJob, { attemptsMade: 3, attempts: 3 }), new Error('dead'));

      expect(error).toHaveBeenCalledTimes(1);
    });

    it('never throws on an undefined job (a throwing handler kills the worker)', () => {
      const p = new SmsProcessor({ sendSms: jest.fn() } as never);
      muteLogger(p);

      expect(() => p.onFailed(undefined, new Error('boom'))).not.toThrow();
      expect(() => p.onStalled('job_9')).not.toThrow();
    });
  });
});

describe('NotificationsProcessor — push fan-out for a committed row', () => {
  it('dispatches to the user with the payload shape the inline path produced', async () => {
    const push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    const p = new NotificationsProcessor(push as never);
    muteLogger(p);

    await p.process(makeJob(notifJob));

    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    expect(push.sendToUser).toHaveBeenCalledWith('usr_1', {
      title: 'Заказ оплачен',
      body: 'Ваш заказ оплачен',
      deeplinkPath: '/orders/1',
      // notification_id + lowercased type merged over the caller's data —
      // byte-for-byte what clients received before the migration.
      data: {
        order_id: 'ord_1',
        notification_id: 'ntf_1',
        type: 'order_paid',
      },
    });
  });

  it('PROPAGATES a push failure so BullMQ retries with backoff', async () => {
    const push = {
      sendToUser: jest.fn().mockRejectedValue(new Error('fcm unavailable')),
    };
    const p = new NotificationsProcessor(push as never);
    muteLogger(p);

    await expect(p.process(makeJob(notifJob))).rejects.toThrow(
      'fcm unavailable',
    );
  });

  it('never writes notification state — a retry cannot corrupt the inbox row', async () => {
    const push = { sendToUser: jest.fn().mockResolvedValue(undefined) };
    const p = new NotificationsProcessor(push as never);
    muteLogger(p);

    await p.process(makeJob(notifJob));
    await p.process(makeJob(notifJob));

    // PushDispatchService is the ONLY collaborator: the worker has no Prisma
    // handle, so the committed row is structurally out of its reach.
    expect(Object.keys(p as object)).not.toContain('prisma');
    expect(push.sendToUser).toHaveBeenCalledTimes(2);
  });

  describe('failure handling', () => {
    it('warns while retries remain, errors when exhausted', () => {
      const p = new NotificationsProcessor({ sendToUser: jest.fn() } as never);
      muteLogger(p);
      const warn = jest.spyOn((p as any).logger, 'warn');
      const error = jest.spyOn((p as any).logger, 'error');

      p.onFailed(makeJob(notifJob, { attemptsMade: 1, attempts: 3 }), new Error('blip'));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();

      p.onFailed(makeJob(notifJob, { attemptsMade: 3, attempts: 3 }), new Error('dead'));
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('never throws on an undefined job', () => {
      const p = new NotificationsProcessor({ sendToUser: jest.fn() } as never);
      muteLogger(p);

      expect(() => p.onFailed(undefined, new Error('boom'))).not.toThrow();
      expect(() => p.onStalled('job_9')).not.toThrow();
    });
  });
});
