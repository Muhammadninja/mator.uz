// The arithmetic behind the refund registry: what an order took in, what has gone
// back, and when nothing is owed any more.

import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundMethod,
} from '@prisma/client';
import {
  readRefundPosition,
  settleRefundPosition,
} from './financial-refund.ledger';

function txWith(state: {
  total?: number;
  payments?: { id: string; amountUzs: number; status?: PaymentStatus }[];
  entries?: { amountUzs: number; paymentId?: string }[];
  timesPaid?: number;
}) {
  return {
    order: {
      findUnique: jest.fn().mockResolvedValue({ totalUzs: state.total ?? 100 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    payment: { findMany: jest.fn().mockResolvedValue(state.payments ?? []) },
    financialRefund: {
      findMany: jest.fn().mockResolvedValue(state.entries ?? []),
    },
    orderStatusHistory: {
      count: jest.fn().mockResolvedValue(state.timesPaid ?? 0),
    },
  };
}

const read = async (tx: ReturnType<typeof txWith>) => {
  const p = await readRefundPosition(tx as never, 'ord_1');
  return {
    received: Number(p.received),
    refunded: Number(p.refunded),
    remaining: Number(p.remaining),
    paymentId: p.paymentId,
  };
};

describe('readRefundPosition', () => {
  it('counts what settled payments took in', async () => {
    const tx = txWith({
      payments: [{ id: 'pay_1', amountUzs: 80 }],
      entries: [{ amountUzs: 30 }],
    });

    expect(await read(tx)).toEqual({
      received: 80,
      refunded: 30,
      remaining: 50,
      paymentId: 'pay_1',
    });
    expect(tx.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'ord_1', status: { in: ['PAID', 'REFUNDED'] } },
      }),
    );
  });

  it('a payment the provider reversed before the registry existed has gone back', async () => {
    const tx = txWith({
      payments: [
        { id: 'pay_1', amountUzs: 80, status: PaymentStatus.REFUNDED },
      ],
    });

    expect(await read(tx)).toMatchObject({
      received: 80,
      refunded: 80,
      remaining: 0,
    });
  });

  it('a reversal with its entry is not counted twice', async () => {
    const tx = txWith({
      payments: [
        { id: 'pay_1', amountUzs: 80, status: PaymentStatus.REFUNDED },
      ],
      entries: [{ amountUzs: 80, paymentId: 'pay_1' }],
    });

    expect(await read(tx)).toMatchObject({ refunded: 80, remaining: 0 });
  });

  it('prefers the payment that still holds the money', async () => {
    const tx = txWith({
      payments: [
        { id: 'pay_new', amountUzs: 50, status: PaymentStatus.REFUNDED },
        { id: 'pay_old', amountUzs: 80, status: PaymentStatus.PAID },
      ],
    });

    expect((await read(tx)).paymentId).toBe('pay_old');
  });

  it('never counts voided entries', async () => {
    const tx = txWith({ payments: [{ id: 'pay_1', amountUzs: 80 }] });

    await read(tx);

    expect(tx.financialRefund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'ord_1', voidedAt: null },
      }),
    );
  });

  it('an order with no payment row that reached PAID took its total', async () => {
    const tx = txWith({ total: 120, timesPaid: 1 });

    expect(await read(tx)).toMatchObject({
      received: 120,
      remaining: 120,
      paymentId: null,
    });
    expect(tx.orderStatusHistory.count).toHaveBeenCalledWith({
      where: { orderId: 'ord_1', status: OrderStatus.PAID },
    });
  });

  it('an order that never reached PAID took nothing', async () => {
    expect(await read(txWith({ total: 120 }))).toMatchObject({
      received: 0,
      remaining: 0,
    });
  });

  it('adds money without floating point drift', async () => {
    const tx = txWith({
      payments: [{ id: 'pay_1', amountUzs: 0.3 }],
      entries: [{ amountUzs: 0.1 }, { amountUzs: 0.2 }],
    });

    const position = await readRefundPosition(tx as never, 'ord_1');

    expect(position.remaining.equals(new Prisma.Decimal(0))).toBe(true);
  });

  it('remaining never goes below zero', async () => {
    const tx = txWith({
      payments: [{ id: 'pay_1', amountUzs: 50 }],
      entries: [{ amountUzs: 80 }],
    });

    expect((await read(tx)).remaining).toBe(0);
  });
});

describe('settleRefundPosition', () => {
  const now = new Date('2026-11-02T10:00:00Z');

  it('marks the order settled once everything is accounted for', async () => {
    const tx = txWith({
      payments: [{ id: 'pay_1', amountUzs: 80 }],
      entries: [{ amountUzs: 50 }, { amountUzs: 30 }],
    });

    await settleRefundPosition(tx as never, 'ord_1', now);

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord_1', refundSettledAt: null },
      data: { refundSettledAt: now },
    });
  });

  it('a partial refund leaves it owed, and a void takes it back', async () => {
    const tx = txWith({
      payments: [{ id: 'pay_1', amountUzs: 80 }],
      entries: [{ amountUzs: 50 }],
    });

    await settleRefundPosition(tx as never, 'ord_1', now);

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord_1', refundSettledAt: { not: null } },
      data: { refundSettledAt: null },
    });
  });

  it('an order that took nothing is never settled', async () => {
    const tx = txWith({});

    await settleRefundPosition(tx as never, 'ord_1', now);

    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { refundSettledAt: null } }),
    );
  });

  it('uses the enum the registry stores', () => {
    expect(RefundMethod.PROVIDER).toBe('PROVIDER');
  });
});
