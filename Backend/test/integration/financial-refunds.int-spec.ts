// The refund registry against a real PostgreSQL: what the mocks cannot show is the row
// lock, the foreign keys, and the callback and the console meeting on one order.
//
// Run with TEST_DATABASE_URL set; see admin-categories.int-spec.ts.

import { ConflictException } from '@nestjs/common';
import {
  AdminAuditAction,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  PaymentType,
  RefundMethod,
} from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { AdminAuditService } from '../../src/admin/auth/admin-audit.service';
import { AdminOrdersService } from '../../src/admin/orders/admin-orders.service';
import { AdminRefundsService } from '../../src/admin/refunds/admin-refunds.service';
import { OrderStatusService } from '../../src/orders/order-status.service';
import { SettlementService } from '../../src/orders/webhooks/settlement.service';
import { fakeConfig } from '../utils/harness';
import { describeWithDb, integrationPrisma } from '../utils/integration-db';

const run = randomBytes(3).toString('hex');
const PREFIX = `it-${run}-`;
const rowId = (name: string) => `${PREFIX}${name}`;
const ACTOR = {
  id: rowId('manager'),
  email: `${rowId('manager')}@mator.test`,
  name: 'Mira',
};

describeWithDb('the refund registry (real PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const audit = new AdminAuditService(prisma as never);
  const refunds = new AdminRefundsService(prisma as never, audit);
  const queue = new AdminOrdersService(prisma as never, fakeConfig() as never);
  const settlement = new SettlementService(
    prisma as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    { emit: jest.fn() } as never,
    new OrderStatusService(prisma as never),
    fakeConfig({ ORDER_TTL_MIN: '30' }),
  );

  let userId: string;

  const cancelledPaidOrder = async (name: string, amount = 100_000) => {
    const order = await prisma.order.create({
      data: {
        id: rowId(name),
        userId,
        status: OrderStatus.CANCELLED,
        paymentType: PaymentType.PAYME,
        subtotalUzs: amount,
        totalUzs: amount,
      },
    });
    const payment = await prisma.payment.create({
      data: {
        id: rowId(`${name}-pay`),
        orderId: order.id,
        provider: PaymentProvider.PAYME,
        status: PaymentStatus.PAID,
        amountUzs: amount,
        providerState: 2,
        providerTransactionId: rowId(`${name}-tx`),
      },
    });
    return { order, payment };
  };

  const entry = (over: Record<string, unknown> = {}) => ({
    amountUzs: 100_000,
    method: RefundMethod.PROVIDER,
    reference: 'CAB-1',
    reason: 'Out of stock',
    ...over,
  });

  const refundDue = async (orderId: string) =>
    (await queue.getOne(orderId)).data.refundDue;

  const code = async (work: Promise<unknown>) => {
    const err = (await work.catch((e: unknown) => e)) as ConflictException;
    expect(err).toBeInstanceOf(ConflictException);
    return (err.getResponse() as { code: string }).code;
  };

  beforeAll(async () => {
    await prisma.appAdmin.create({
      data: { ...ACTOR, passwordHash: 'not-a-real-hash' },
    });
    userId = randomUUID();
    await prisma.appUser.create({
      data: { id: userId, email: `${PREFIX}buyer@mator.test` },
    });
  });

  afterEach(async () => {
    await prisma.adminAudit.deleteMany({
      where: { targetEntityId: { startsWith: PREFIX } },
    });
    await prisma.financialRefund.deleteMany({
      where: { orderId: { startsWith: PREFIX } },
    });
    await prisma.orderStatusHistory.deleteMany({
      where: { orderId: { startsWith: PREFIX } },
    });
    await prisma.payment.deleteMany({
      where: { orderId: { startsWith: PREFIX } },
    });
    await prisma.order.deleteMany({ where: { id: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma.appAdmin.deleteMany({ where: { id: ACTOR.id } });
    await prisma.appUser.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('records money returned, audits it, clears "refund due", and touches no status', async () => {
    const { order, payment } = await cancelledPaidOrder('full');
    expect(await refundDue(order.id)).toBe(true);

    await refunds.record(order.id, entry(), { actor: ACTOR });

    expect(await refundDue(order.id)).toBe(false);
    const after = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(after.status).toBe(OrderStatus.CANCELLED);
    expect(after.refundSettledAt).toBeInstanceOf(Date);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
        .status,
    ).toBe(PaymentStatus.PAID);

    const audited = await prisma.adminAudit.findFirstOrThrow({
      where: {
        action: AdminAuditAction.REFUND_RECORDED,
        targetEntityId: order.id,
      },
    });
    expect(audited.actorEmail).toBe(ACTOR.email);
    expect(audited.reason).toBe('Out of stock');
    expect(audited.newValues).toMatchObject({
      amountUzs: '100000.00',
      reference: 'CAB-1',
    });
  });

  it('a partial refund leaves the rest owed, until the rest is recorded', async () => {
    const { order } = await cancelledPaidOrder('partial');

    await refunds.record(order.id, entry({ amountUzs: 40_000 }));
    expect(await refundDue(order.id)).toBe(true);

    const state = await refunds.forOrder(order.id);
    expect(state.data).toMatchObject({
      received: 100_000,
      refunded: 40_000,
      remaining: 60_000,
    });

    await refunds.record(
      order.id,
      entry({ amountUzs: 60_000, reference: 'CAB-2' }),
    );
    expect(await refundDue(order.id)).toBe(false);
  });

  it('of two people recording at once, one wins and the other is told', async () => {
    const { order } = await cancelledPaidOrder('race');

    const results = await Promise.allSettled([
      refunds.record(order.id, entry({ reference: 'A' })),
      refunds.record(order.id, entry({ reference: 'B' })),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(
      await prisma.financialRefund.count({ where: { orderId: order.id } }),
    ).toBe(1);
  });

  it('a double submit of one document records it once', async () => {
    const { order } = await cancelledPaidOrder('double');

    const results = await Promise.allSettled([
      refunds.record(order.id, entry({ amountUzs: 10_000 })),
      refunds.record(order.id, entry({ amountUzs: 10_000 })),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(
      await prisma.financialRefund.count({ where: { orderId: order.id } }),
    ).toBe(1);
  });

  it('never lets more go back than came in', async () => {
    const { order } = await cancelledPaidOrder('over');

    expect(
      await code(refunds.record(order.id, entry({ amountUzs: 100_000.01 }))),
    ).toBe('REFUND_EXCEEDS_RECEIVED');
    expect(
      await prisma.financialRefund.count({ where: { orderId: order.id } }),
    ).toBe(0);
  });

  it('refuses an order that never took money', async () => {
    const order = await prisma.order.create({
      data: {
        id: rowId('unpaid'),
        userId,
        status: OrderStatus.PENDING_PAYMENT,
        paymentType: PaymentType.CASH,
        subtotalUzs: 5,
        totalUzs: 5,
      },
    });

    expect(
      await code(
        refunds.record(
          order.id,
          entry({ amountUzs: 5, method: RefundMethod.CASH }),
        ),
      ),
    ).toBe('REFUND_NOTHING_RECEIVED');
  });

  it('a cash order that reached PAID can be refunded, but not through a provider', async () => {
    const order = await prisma.order.create({
      data: {
        id: rowId('cash'),
        userId,
        status: OrderStatus.CANCELLED,
        paymentType: PaymentType.CASH,
        subtotalUzs: 70_000,
        totalUzs: 70_000,
        statusHistory: {
          create: {
            id: rowId('cash-paid'),
            status: OrderStatus.PAID,
          },
        },
      },
    });

    expect(
      await code(refunds.record(order.id, entry({ amountUzs: 70_000 }))),
    ).toBe('REFUND_NO_PROVIDER_PAYMENT');

    const res = await refunds.record(
      order.id,
      entry({
        amountUzs: 70_000,
        method: RefundMethod.CASH,
        reference: 'RKO-7',
      }),
    );
    expect(res.data.method).toBe('cash');
  });

  it('a void keeps the entry, frees its amount and puts the debt back', async () => {
    const { order } = await cancelledPaidOrder('void');
    const { data } = await refunds.record(order.id, entry());
    expect(await refundDue(order.id)).toBe(false);

    await refunds.voidEntry(
      data.id,
      { reason: 'Wrong order' },
      { actor: ACTOR },
    );

    expect(await refundDue(order.id)).toBe(true);
    const kept = await prisma.financialRefund.findUniqueOrThrow({
      where: { id: data.id },
    });
    expect(kept.voidReason).toBe('Wrong order');
    expect(kept.voidedByEmail).toBe(ACTOR.email);

    expect(await code(refunds.voidEntry(data.id, { reason: 'Again' }))).toBe(
      'REFUND_ALREADY_VOIDED',
    );
    // The same document can go in again, correctly this time.
    await refunds.record(order.id, entry());
    expect(await refundDue(order.id)).toBe(false);
  });

  describe('the provider callback', () => {
    it('enters a refund nobody recorded, once', async () => {
      const { order, payment } = await cancelledPaidOrder('callback');

      await settlement.markCancelled(payment.id, 5, true);
      await settlement.markCancelled(payment.id, 5, true);

      const rows = await prisma.financialRefund.findMany({
        where: { orderId: order.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: 'PROVIDER_CALLBACK',
        method: RefundMethod.PROVIDER,
        reference: payment.providerTransactionId,
      });
      expect(Number(rows[0].amountUzs)).toBe(100_000);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
          .status,
      ).toBe(OrderStatus.REFUNDED);
    });

    it('confirms what a manager already wrote instead of counting it twice', async () => {
      const { order, payment } = await cancelledPaidOrder('confirm');
      const { data } = await refunds.record(order.id, entry());

      await settlement.markCancelled(payment.id, 5, true);

      const rows = await prisma.financialRefund.findMany({
        where: { orderId: order.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(data.id);
      expect(rows[0].providerConfirmedAt).toBeInstanceOf(Date);

      expect(await code(refunds.voidEntry(data.id, { reason: 'No' }))).toBe(
        'REFUND_CONFIRMED_BY_PROVIDER',
      );
    });

    it('after it, nothing more can be recorded', async () => {
      const { order, payment } = await cancelledPaidOrder('after');
      await settlement.markCancelled(payment.id, 5, true);

      expect(
        await code(refunds.record(order.id, entry({ amountUzs: 1 }))),
      ).toBe('REFUND_EXCEEDS_RECEIVED');
    });
  });

  describe('the registry', () => {
    it('lists newest first, hides voided by default, and totals real money only', async () => {
      const { order } = await cancelledPaidOrder('list');
      await refunds.record(
        order.id,
        entry({
          amountUzs: 10_000,
          reference: 'OLD',
          refundedAt: '2026-01-01T00:00:00Z',
        }),
      );
      const wrong = await refunds.record(
        order.id,
        entry({ amountUzs: 20_000, reference: 'WRONG' }),
      );
      await refunds.voidEntry(wrong.data.id, { reason: 'Typo' });
      await refunds.record(
        order.id,
        entry({ amountUzs: 30_000, reference: 'NEW' }),
      );

      const mine = await refunds.forOrder(order.id);
      expect(mine.data.refunds.map((r) => r.reference)).toEqual([
        'NEW',
        'WRONG',
        'OLD',
      ]);
      expect(mine.data.refunded).toBe(40_000);

      const voided = await refunds.list({ state: 'voided', limit: 100 });
      expect(voided.data.map((r) => r.id)).toContain(wrong.data.id);
      const active = await refunds.list({ limit: 100 });
      expect(active.data.map((r) => r.id)).not.toContain(wrong.data.id);
    });

    it('an order with refunds cannot be deleted: the record of the money must survive', async () => {
      const { order } = await cancelledPaidOrder('fk');
      await refunds.record(order.id, entry());

      await expect(
        prisma.order.delete({ where: { id: order.id } }),
      ).rejects.toThrow();
    });
  });
});
