// Unit tests for NotificationsService.emit() after the BullMQ migration.
//
// The contract being pinned:
//   • the inbox row is written SYNCHRONOUSLY (DB is the source of truth and the
//     row is the caller's return value)
//   • push is ENQUEUED, never dispatched inline
//   • the preference/quiet-hours gate runs at emit time, so a suppressed
//     notification never becomes a job
//   • an enqueue failure never fails the caller (the row is already committed)

import { NotificationType } from '@prisma/client';
import { NotificationsService } from './notifications.service';

function makePrisma(pref: unknown = null) {
  const created: unknown[] = [];
  return {
    created,
    notification: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { ...data, id: data.id ?? 'ntf_1' };
      }),
    },
    notificationPreference: {
      findUnique: jest.fn(async () => pref),
    },
  };
}

function makeQueue() {
  return { enqueueNotification: jest.fn().mockResolvedValue({ id: 'job_1' }) };
}

function build(pref: unknown = null) {
  const prisma = makePrisma(pref);
  const queue = makeQueue();
  const service = new NotificationsService(prisma as never, queue as never);
  jest
    .spyOn((service as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return { service, prisma, queue };
}

const input = {
  type: NotificationType.ORDER_PAID,
  title: 'Заказ оплачен',
  body: 'Ваш заказ оплачен',
  data: { order_id: 'ord_1' },
  deeplinkPath: '/orders/1',
};

describe('NotificationsService.emit — queued, not sent inline', () => {
  it('persists the inbox row and returns it to the caller', async () => {
    const { service, prisma } = build();

    const result = await service.emit('usr_1', input);

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    // Callers (orders, bookings, vehicles, the AI advisor) use this return value.
    expect(result.id).toEqual(expect.any(String));
    expect(result.userId).toBe('usr_1');
  });

  it('ENQUEUES the push instead of dispatching it inline', async () => {
    const { service, queue } = build();

    const notification = await service.emit('usr_1', input);

    expect(queue.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(queue.enqueueNotification).toHaveBeenCalledWith({
      userId: 'usr_1',
      type: NotificationType.ORDER_PAID,
      // The committed row's id — both fan-out target and idempotency key.
      notificationId: notification.id,
      title: 'Заказ оплачен',
      body: 'Ваш заказ оплачен',
      deeplinkPath: '/orders/1',
      payload: { order_id: 'ord_1' },
    });
  });

  it('writes the row BEFORE enqueueing (never enqueue an uncommitted row)', async () => {
    const order: string[] = [];
    const prisma = makePrisma();
    prisma.notification.create = jest.fn(async ({ data }: any) => {
      order.push('db-create');
      return { ...data, id: 'ntf_1' };
    });
    const queue = {
      enqueueNotification: jest.fn(async () => {
        order.push('enqueue');
        return { id: 'job_1' };
      }),
    };
    const service = new NotificationsService(prisma as never, queue as never);

    await service.emit('usr_1', input);

    expect(order).toEqual(['db-create', 'enqueue']);
  });

  it('does not enqueue when the category preference is off', async () => {
    // ORDER_PAID is gated by the `payments` flag.
    const { service, queue, prisma } = build({
      payments: false,
      quietHoursStart: null,
      quietHoursEnd: null,
    });

    await service.emit('usr_1', input);

    // Suppressed at emit time — a muted notification never becomes a job.
    expect(queue.enqueueNotification).not.toHaveBeenCalled();
    // …but the inbox row is still written: the user sees it in the app.
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue during quiet hours', async () => {
    // A window covering the whole day, so the test is time-independent.
    const { service, queue } = build({
      payments: true,
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
    });

    await service.emit('usr_1', input);

    expect(queue.enqueueNotification).not.toHaveBeenCalled();
  });

  it('still returns the row when the enqueue fails (row already committed)', async () => {
    const { service, queue } = build();
    queue.enqueueNotification.mockRejectedValueOnce(new Error('redis down'));

    // Must not throw: the caller's business action (order paid, booking made)
    // already succeeded and its inbox row is saved. Push is best-effort.
    const result = await service.emit('usr_1', input);

    expect(result.id).toEqual(expect.any(String));
  });
});
