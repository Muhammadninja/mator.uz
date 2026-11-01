// The waiting rules for cash and terminal orders, and the monitor that acts on them.
// Off by default on purpose: each action messages a real customer or closes an order.

import { OrderStatus, PaymentType } from '@prisma/client';
import { OfflineOrderMonitorService } from './offline-order-monitor.service';
import {
  isOverOfflineSla,
  isPastOperatorWarning,
  readOfflineOrderPolicy,
} from './offline-order.policy';

const env =
  (map: Record<string, string>) =>
  (key: string): string | undefined =>
    map[key];

describe('readOfflineOrderPolicy', () => {
  it('flags overdue orders by default and does nothing to customers or orders', () => {
    expect(readOfflineOrderPolicy(env({}))).toEqual({
      slaHours: 2,
      operatorWarningHours: 4,
      customerNoticeHours: 0,
      timeoutHours: 0,
    });
  });

  it('reads each from the environment', () => {
    expect(
      readOfflineOrderPolicy(
        env({
          OFFLINE_ORDER_SLA_HOURS: '1.5',
          OFFLINE_ORDER_OPERATOR_WARNING_HOURS: '3',
          OFFLINE_ORDER_CUSTOMER_NOTICE_HOURS: '4',
          OFFLINE_ORDER_TIMEOUT_HOURS: '72',
        }),
      ),
    ).toEqual({
      slaHours: 1.5,
      operatorWarningHours: 3,
      customerNoticeHours: 4,
      timeoutHours: 72,
    });
  });

  it.each(['abc', '-1', ''])('ignores %p rather than guessing', (bad) => {
    expect(
      readOfflineOrderPolicy(env({ OFFLINE_ORDER_TIMEOUT_HOURS: bad }))
        .timeoutHours,
    ).toBe(0);
  });
});

describe('isOverOfflineSla', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const policy = {
    slaHours: 2,
    operatorWarningHours: 4,
    customerNoticeHours: 0,
    timeoutHours: 0,
  };
  const order = (over: Record<string, unknown> = {}) => ({
    status: OrderStatus.PENDING_PAYMENT,
    paymentType: PaymentType.CASH as PaymentType | null,
    createdAt: new Date('2026-11-01T09:00:00Z'),
    ...over,
  });

  it('is true for a cash or terminal order waiting past the SLA', () => {
    expect(isOverOfflineSla(order(), now, policy)).toBe(true);
    expect(
      isOverOfflineSla(order({ paymentType: 'TERMINAL' }), now, policy),
    ).toBe(true);
  });

  it('is false inside the SLA, once confirmed, and for an online order', () => {
    expect(
      isOverOfflineSla(
        order({ createdAt: new Date('2026-11-01T11:00:00Z') }),
        now,
        policy,
      ),
    ).toBe(false);
    expect(
      isOverOfflineSla(order({ status: OrderStatus.PAID }), now, policy),
    ).toBe(false);
    expect(isOverOfflineSla(order({ paymentType: 'PAYME' }), now, policy)).toBe(
      false,
    );
    expect(isOverOfflineSla(order({ paymentType: null }), now, policy)).toBe(
      false,
    );
  });
});

describe('OfflineOrderMonitorService', () => {
  const now = new Date('2026-11-01T12:00:00Z');

  function build(map: Record<string, string> = {}) {
    const prisma = {
      order: { findMany: jest.fn().mockResolvedValue([]) },
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const orderStatus = {
      expireUnconfirmedOffline: jest.fn().mockResolvedValue([]),
    };
    const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
    const service = new OfflineOrderMonitorService(
      prisma as never,
      orderStatus as never,
      notifications as never,
      { get: env(map) } as never,
    );
    return { service, prisma, orderStatus, notifications };
  }

  it('does nothing at all until it is configured', async () => {
    const { service, prisma, orderStatus, notifications } = build();

    await service.sweep(now);

    expect(orderStatus.expireUnconfirmedOffline).not.toHaveBeenCalled();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('tells a customer about a delay once, however many sweeps run', async () => {
    const { service, prisma, notifications } = build({
      OFFLINE_ORDER_CUSTOMER_NOTICE_HOURS: '4',
    });
    prisma.order.findMany.mockResolvedValue([{ id: 'ord_1', userId: 'u1' }]);

    await service.sweep(now);
    expect(notifications.emit).toHaveBeenCalledTimes(1);
    expect(notifications.emit.mock.calls[0][1].data).toMatchObject({
      offline_delay_for: 'ord_1',
    });

    prisma.notification.findFirst.mockResolvedValue({ id: 'n1' });
    await service.sweep(now);
    expect(notifications.emit).toHaveBeenCalledTimes(1);
  });

  it('expires past the timeout and tells the customer', async () => {
    const { service, orderStatus, notifications } = build({
      OFFLINE_ORDER_TIMEOUT_HOURS: '72',
    });
    orderStatus.expireUnconfirmedOffline.mockResolvedValue([
      { id: 'ord_2', userId: 'u2' },
    ]);

    await service.sweep(now);

    expect(orderStatus.expireUnconfirmedOffline).toHaveBeenCalledWith(
      now,
      72,
      expect.any(Number),
    );
    expect(notifications.emit.mock.calls[0][0]).toBe('u2');
    expect(notifications.emit.mock.calls[0][1].data).toMatchObject({
      order_id: 'ord_2',
      status: 'expired',
    });
  });

  it('a failed message does not stop the sweep', async () => {
    const { service, orderStatus, notifications } = build({
      OFFLINE_ORDER_TIMEOUT_HOURS: '72',
    });
    orderStatus.expireUnconfirmedOffline.mockResolvedValue([
      { id: 'ord_a', userId: 'ua' },
      { id: 'ord_b', userId: 'ub' },
    ]);
    notifications.emit.mockRejectedValueOnce(new Error('inbox down'));

    await expect(service.sweep(now)).resolves.toBeUndefined();

    expect(notifications.emit).toHaveBeenCalledTimes(2);
  });
});

describe('isPastOperatorWarning', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const policy = {
    slaHours: 2,
    operatorWarningHours: 4,
    customerNoticeHours: 0,
    timeoutHours: 0,
  };
  const waitingFor = (hours: number, over: Record<string, unknown> = {}) => ({
    status: OrderStatus.PENDING_PAYMENT,
    paymentType: PaymentType.CASH as PaymentType | null,
    createdAt: new Date(now.getTime() - hours * 60 * 60 * 1000),
    ...over,
  });

  it('comes after the SLA, not with it', () => {
    expect(isOverOfflineSla(waitingFor(3), now, policy)).toBe(true);
    expect(isPastOperatorWarning(waitingFor(3), now, policy)).toBe(false);
    expect(isPastOperatorWarning(waitingFor(5), now, policy)).toBe(true);
  });

  it('applies to a cash or terminal order still waiting, and nothing else', () => {
    expect(
      isPastOperatorWarning(
        waitingFor(5, { paymentType: 'TERMINAL' }),
        now,
        policy,
      ),
    ).toBe(true);
    expect(
      isPastOperatorWarning(
        waitingFor(5, { paymentType: 'PAYME' }),
        now,
        policy,
      ),
    ).toBe(false);
    expect(
      isPastOperatorWarning(
        waitingFor(5, { status: OrderStatus.PAID }),
        now,
        policy,
      ),
    ).toBe(false);
  });

  it('can be switched off', () => {
    expect(
      isPastOperatorWarning(waitingFor(500), now, {
        ...policy,
        operatorWarningHours: 0,
      }),
    ).toBe(false);
  });

  it('defaults to 4 hours and reads its own setting', () => {
    expect(readOfflineOrderPolicy(() => undefined).operatorWarningHours).toBe(
      4,
    );
    expect(
      readOfflineOrderPolicy((key) =>
        key === 'OFFLINE_ORDER_OPERATOR_WARNING_HOURS' ? '6' : undefined,
      ).operatorWarningHours,
    ).toBe(6);
  });
});
