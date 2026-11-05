// The order status rules against a real PostgreSQL: what the sweeper's scan
// selects (a Prisma `where` over a NULLable enum, whose SQL semantics a mock cannot
// show), and how an operator's status write and a provider payment interact.
//
// Run with TEST_DATABASE_URL set; see admin-categories.int-spec.ts.

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  AdminRole,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  PaymentType,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { AdminAuditService } from '../../src/admin/auth/admin-audit.service';
import { AdminOrdersService } from '../../src/admin/orders/admin-orders.service';
import { OfflineOrderMonitorService } from '../../src/orders/offline-order-monitor.service';
import { OrderStatusService } from '../../src/orders/order-status.service';
import { OrdersService } from '../../src/orders/orders.service';
import { SettlementService } from '../../src/orders/webhooks/settlement.service';
import { fakeConfig } from '../utils/harness';
import { describeWithDb, integrationPrisma } from '../utils/integration-db';

const run = randomBytes(3).toString('hex');
const orderId = (name: string) => `it-${run}-${name}`;

describeWithDb('order lifecycle (real PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const statuses = new OrderStatusService(prisma as never);
  const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
  const realtime = { emit: jest.fn() };
  const orders = new OrdersService(
    prisma as never,
    fakeConfig() as never,
    notifications as never,
    realtime as never,
    statuses,
    {} as never,
    new AdminAuditService(prisma as never),
    {} as never,
  );
  const settlement = new SettlementService(
    prisma as never,
    notifications as never,
    realtime as never,
    statuses,
    fakeConfig() as never,
  );
  const actor = {
    id: orderId('admin-op'),
    role: 'ADMIN',
    adminRole: AdminRole.OPERATOR,
    email: 'operator@mator.uz',
    displayName: 'Operator',
  };
  const manager = {
    ...actor,
    id: orderId('admin-mgr'),
    adminRole: AdminRole.MANAGER,
    email: 'manager@mator.uz',
    displayName: 'Manager',
  };

  let userId: string;

  const order = (
    name: string,
    paymentType: PaymentType | null,
    overdue = true,
    status: OrderStatus = OrderStatus.PENDING_PAYMENT,
  ) =>
    prisma.order.create({
      data: {
        id: orderId(name),
        userId,
        status,
        subtotalUzs: 100_000,
        totalUzs: 100_000,
        paymentType,
        expiresAt: new Date(Date.now() + (overdue ? -60_000 : 60_000)),
      },
    });

  const statusOf = async (id: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    // Audit entries reference the acting administrator's real row.
    await prisma.appAdmin.createMany({
      data: [
        actor.id,
        manager.id,
        ...Array.from({ length: 5 }, (_, i) => orderId(`admin-${i}`)),
      ].map((id) => ({
        id,
        email: `${id}@mator.test`,
        passwordHash: 'not-a-real-hash',
        name: id,
      })),
    });
    const user = await prisma.appUser.create({
      data: { phoneE164: `+99890${Date.now().toString().slice(-7)}` },
    });
    userId = user.id;
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await prisma.adminAudit.deleteMany({
      where: { targetEntityId: { startsWith: `it-${run}-` } },
    });
    // A provider refund enters the registry, whose rows hold their order in place.
    await prisma.financialRefund.deleteMany({
      where: { orderId: { startsWith: `it-${run}-` } },
    });
    await prisma.order.deleteMany({
      where: { id: { startsWith: `it-${run}-` } },
    });
  });

  afterAll(async () => {
    await prisma.appUser.deleteMany({ where: { id: userId } });
    await prisma.appAdmin.deleteMany({
      where: { id: { startsWith: `it-${run}-` } },
    });
    await prisma.$disconnect();
  });

  describe('the payment window sweeper', () => {
    it.each([PaymentType.CASH, PaymentType.TERMINAL])(
      'leaves an overdue %s order alone: it is waiting for an operator, not a payment',
      async (type) => {
        const o = await order(`offline-${type}`, type);

        await statuses.expireOverdue(new Date());

        expect(await statusOf(o.id)).toBe(OrderStatus.PENDING_PAYMENT);
      },
    );

    it('expires an overdue online order', async () => {
      const o = await order('online', PaymentType.PAYME);

      await statuses.expireOverdue(new Date());

      expect(await statusOf(o.id)).toBe(OrderStatus.EXPIRED);
    });

    it('still expires an overdue order from a client that sent no payment type', async () => {
      const o = await order('untyped', null);

      await statuses.expireOverdue(new Date());

      expect(await statusOf(o.id)).toBe(OrderStatus.EXPIRED);
    });

    it('leaves an online order whose provider transaction is live', async () => {
      const o = await order('reserved', PaymentType.PAYME);
      await prisma.payment.create({
        data: {
          id: orderId('reserved-pay'),
          orderId: o.id,
          provider: PaymentProvider.PAYME,
          amountUzs: 100_000,
          providerState: 1,
        },
      });

      await statuses.expireOverdue(new Date());

      expect(await statusOf(o.id)).toBe(OrderStatus.PENDING_PAYMENT);
    });
  });

  describe('an operator marking an order paid', () => {
    it('confirms a cash order, with a history row naming the operator', async () => {
      const o = await order('cash-paid', PaymentType.CASH, false);

      await orders.updateStatus(o.id, { status: 'paid' }, actor);

      expect(await statusOf(o.id)).toBe(OrderStatus.PAID);
      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId: o.id },
      });
      expect(history).toHaveLength(1);
      expect(history[0].actorId).toBe(actor.id);
    });

    it('an operator cannot confirm an online order, with or without a note', async () => {
      const o = await order('payme-operator', PaymentType.PAYME, false);

      await expect(
        orders.updateStatus(o.id, { status: 'paid', note: 'x' }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await statusOf(o.id)).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it('a manager must say how, and that leaves a full audit trail', async () => {
      const o = await order('payme-note', PaymentType.PAYME, false);
      const failed = await prisma.payment.create({
        data: {
          id: orderId('payme-note-pay'),
          orderId: o.id,
          provider: PaymentProvider.PAYME,
          status: PaymentStatus.CANCELLED,
          amountUzs: 100_000,
          providerState: -1,
          providerTransactionId: orderId('tx'),
        },
      });

      await expect(
        orders.updateStatus(o.id, { status: 'paid' }, manager),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await statusOf(o.id)).toBe(OrderStatus.PENDING_PAYMENT);

      await orders.updateStatus(
        o.id,
        {
          status: 'paid',
          note: 'Reconciled in the Payme cabinet',
          paymentReference: 'PM-77',
        },
        manager,
        { ip: '203.0.113.9', userAgent: 'it' },
      );

      const history = await prisma.orderStatusHistory.findFirstOrThrow({
        where: { orderId: o.id },
      });
      expect(history).toMatchObject({
        note: 'Reconciled in the Payme cabinet [PM-77]',
        actorId: manager.id,
        actorName: manager.displayName,
        status: OrderStatus.PAID,
      });
      const entry = await prisma.adminAudit.findFirstOrThrow({
        where: {
          action: AdminAuditAction.ORDER_PAYMENT_CONFIRMED,
          targetEntityId: o.id,
        },
      });
      expect(entry).toMatchObject({
        actorEmail: manager.email,
        reason: 'Reconciled in the Payme cabinet',
        ip: '203.0.113.9',
      });
      expect(entry.previousValues).toMatchObject({
        status: 'PENDING_PAYMENT',
        paymentType: 'PAYME',
        payments: [{ id: failed.id, providerState: -1 }],
      });
      expect(entry.newValues).toMatchObject({
        status: 'PAID',
        paymentReference: 'PM-77',
      });
    });

    it('an operator confirming cash is on the record too', async () => {
      const o = await order('cash-audit', PaymentType.CASH, false);

      await orders.updateStatus(o.id, { status: 'paid' }, actor);

      const entry = await prisma.adminAudit.findFirstOrThrow({
        where: { targetEntityId: o.id },
      });
      expect(entry.action).toBe(AdminAuditAction.ORDER_PAYMENT_CONFIRMED);
    });

    it('cannot take an order out from under a payment in progress', async () => {
      const o = await order('in-progress', PaymentType.PAYME, false);
      const payment = await prisma.payment.create({
        data: {
          id: orderId('in-progress-pay'),
          orderId: o.id,
          provider: PaymentProvider.PAYME,
          amountUzs: 100_000,
          providerState: 1,
        },
      });

      await expect(
        orders.updateStatus(o.id, { status: 'paid', note: 'x' }, manager),
      ).rejects.toBeInstanceOf(ConflictException);

      // The customer's payment still settles the order normally.
      expect(await settlement.markPaid(payment.id)).toBe('paid');
      expect(await statusOf(o.id)).toBe(OrderStatus.PAID);
      const settled = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(settled.status).toBe(PaymentStatus.PAID);
    });
  });

  describe('the wait for an operator on cash and terminal orders', () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const monitorWith = (config: Record<string, string>) =>
      new OfflineOrderMonitorService(
        prisma as never,
        statuses,
        notifications as never,
        fakeConfig(config) as never,
      );
    const queueWith = (config: Record<string, string> = {}) =>
      new AdminOrdersService(prisma as never, fakeConfig(config) as never);
    const age = (id: string, h: number) =>
      prisma.order.update({ where: { id }, data: { createdAt: hoursAgo(h) } });

    it('is flagged past the SLA, in the row, the filter and the summary', async () => {
      const late = await order('sla-late', PaymentType.CASH, false);
      await age(late.id, 3);
      const fresh = await order('sla-fresh', PaymentType.TERMINAL, false);
      const online = await order('sla-online', PaymentType.PAYME, false);
      await age(online.id, 3);

      const queue = queueWith({ OFFLINE_ORDER_SLA_HOURS: '2' });
      const search = `it-${run}-sla-`;
      const all = await queue.list({ search, limit: 10 });
      const flag = (id: string) =>
        all.data.find((o) => o.id === id)?.slaOverdue;
      expect(flag(late.id)).toBe(true);
      expect(flag(fresh.id)).toBe(false);
      expect(flag(online.id)).toBe(false);

      const filtered = await queue.list({ search, slaOverdue: 'true' });
      expect(filtered.data.map((o) => o.id)).toEqual([late.id]);

      const summary = await queue.summary();
      expect(summary.data.slaOverdue).toBeGreaterThanOrEqual(1);
      expect(summary.data.slaHours).toBe(2);
    });

    it('does nothing to the order or the customer until configured', async () => {
      const o = await order('monitor-off', PaymentType.CASH, false);
      await age(o.id, 500);

      await monitorWith({}).sweep();

      expect(await statusOf(o.id)).toBe(OrderStatus.PENDING_PAYMENT);
      expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('expires past the configured timeout, with a history note and a message', async () => {
      const o = await order('monitor-timeout', PaymentType.TERMINAL, false);
      await age(o.id, 73);
      const inside = await order('monitor-inside', PaymentType.CASH, false);
      await age(inside.id, 71);

      await monitorWith({ OFFLINE_ORDER_TIMEOUT_HOURS: '72' }).sweep();

      expect(await statusOf(o.id)).toBe(OrderStatus.EXPIRED);
      expect(await statusOf(inside.id)).toBe(OrderStatus.PENDING_PAYMENT);
      const history = await prisma.orderStatusHistory.findFirstOrThrow({
        where: { orderId: o.id },
      });
      expect(history.note).toContain('within 72h');
      expect(history.actorType).toBe('SYSTEM');
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      expect(notifications.emit.mock.calls[0][1].data.order_id).toBe(o.id);
    });

    it('never expires an order an operator has confirmed', async () => {
      const o = await order(
        'monitor-paid',
        PaymentType.CASH,
        false,
        OrderStatus.PAID,
      );
      await age(o.id, 500);

      await monitorWith({ OFFLINE_ORDER_TIMEOUT_HOURS: '72' }).sweep();

      expect(await statusOf(o.id)).toBe(OrderStatus.PAID);
    });

    it('tells the customer about a delay exactly once across sweeps', async () => {
      const o = await order('monitor-notice', PaymentType.CASH, false);
      await age(o.id, 5);
      const monitor = monitorWith({ OFFLINE_ORDER_CUSTOMER_NOTICE_HOURS: '4' });
      notifications.emit.mockImplementation(
        async (userId: string, input: Record<string, unknown>) => {
          await prisma.notification.create({
            data: {
              id: orderId(`n-${Math.random().toString(36).slice(2, 8)}`),
              userId,
              type: input.type as never,
              title: input.title as string,
              body: input.body as string,
              data: input.data as never,
            },
          });
        },
      );

      await monitor.sweep();
      await monitor.sweep();

      expect(notifications.emit).toHaveBeenCalledTimes(1);
      notifications.emit.mockReset();
      notifications.emit.mockResolvedValue(undefined);
      await prisma.notification.deleteMany({ where: { userId } });
    });
  });

  describe('cancelling a paid order', () => {
    const paid = async (name: string) => {
      const o = await order(name, PaymentType.PAYME, false, OrderStatus.PAID);
      const payment = await prisma.payment.create({
        data: {
          id: orderId(`${name}-pay`),
          orderId: o.id,
          provider: PaymentProvider.PAYME,
          status: PaymentStatus.PAID,
          amountUzs: 100_000,
          providerState: 2,
        },
      });
      return { o, payment };
    };
    const queue = () =>
      new AdminOrdersService(prisma as never, fakeConfig() as never);

    it('needs a reason, leaves the money as it was, and shows a refund is owed', async () => {
      const { o, payment } = await paid('refund-owed');

      await expect(
        orders.updateStatus(o.id, { status: 'cancelled' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);

      await orders.updateStatus(
        o.id,
        { status: 'cancelled', note: 'Out of stock' },
        actor,
      );

      expect(await statusOf(o.id)).toBe(OrderStatus.CANCELLED);
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .status,
      ).toBe(PaymentStatus.PAID);

      const list = await queue().list({
        search: o.id,
        refundDue: 'true',
      });
      expect(list.data.map((row) => row.id)).toEqual([o.id]);
      expect(list.data[0].refundDue).toBe(true);
      expect((await queue().getOne(o.id)).data.refundDue).toBe(true);

      const entry = await prisma.adminAudit.findFirstOrThrow({
        where: { targetEntityId: o.id },
      });
      expect(entry).toMatchObject({
        action: AdminAuditAction.ORDER_CANCELLED,
        reason: 'Out of stock',
      });
    });

    it('only the provider’s confirmation makes it refunded, once, and clears the flag', async () => {
      const { o, payment } = await paid('refund-done');
      await orders.updateStatus(
        o.id,
        { status: 'cancelled', note: 'Out of stock' },
        actor,
      );

      await settlement.markCancelled(payment.id, 5, true);
      await settlement.markCancelled(payment.id, 5, true);

      expect(await statusOf(o.id)).toBe(OrderStatus.REFUNDED);
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .status,
      ).toBe(PaymentStatus.REFUNDED);
      const refundRows = await prisma.orderStatusHistory.count({
        where: { orderId: o.id, status: OrderStatus.REFUNDED },
      });
      expect(refundRows).toBe(1);
      expect((await queue().getOne(o.id)).data.refundDue).toBe(false);
    });

    it('an operator cannot claim a refund by hand', async () => {
      const { o } = await paid('refund-claim');

      await expect(
        orders.updateStatus(o.id, { status: 'refunded', note: 'x' }, manager),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await statusOf(o.id)).toBe(OrderStatus.PAID);
    });
  });

  describe('several operators on one order', () => {
    it('five at once: one wins, the rest are told, one history row', async () => {
      const o = await order('five', PaymentType.CASH, false, OrderStatus.PAID);
      const operators = Array.from({ length: 5 }, (_, i) => ({
        ...actor,
        id: orderId(`admin-${i}`),
      }));

      const results = await Promise.allSettled(
        operators.map((op, i) =>
          orders.updateStatus(
            o.id,
            i % 2
              ? { status: 'processing' }
              : { status: 'cancelled', note: 'x' },
            op,
          ),
        ),
      );

      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toBeInstanceOf(HttpException);
        }
      }
      expect(
        await prisma.orderStatusHistory.count({ where: { orderId: o.id } }),
      ).toBe(1);
    });

    it('a repeated request after the first succeeded changes nothing more', async () => {
      const o = await order(
        'repeat',
        PaymentType.CASH,
        false,
        OrderStatus.PAID,
      );

      await orders.updateStatus(o.id, { status: 'processing' }, actor);
      await orders.updateStatus(o.id, { status: 'processing' }, actor);

      expect(
        await prisma.orderStatusHistory.count({ where: { orderId: o.id } }),
      ).toBe(1);
    });
  });

  describe('the admin queue', () => {
    it('pages through orders sharing a sort value without repeating or losing one', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        ids.push((await order(`page-${i}`, PaymentType.CASH, false)).id);
      }
      const queue = new AdminOrdersService(
        prisma as never,
        fakeConfig() as never,
      );

      const seen: string[] = [];
      for (let page = 1; page <= 4; page += 1) {
        const res = await queue.list({
          page,
          limit: 2,
          sortBy: 'status',
          search: `it-${run}-page-`,
        });
        seen.push(...res.data.map((o) => o.id));
      }

      expect([...seen].sort()).toEqual([...ids].sort());
    });

    it('takes several statuses at once, which the attention counters rely on', async () => {
      const waiting = await order('count-a', PaymentType.CASH, false);
      const paid = await order(
        'count-b',
        PaymentType.CASH,
        false,
        OrderStatus.PAID,
      );
      await order('count-c', PaymentType.CASH, false, OrderStatus.SHIPPED);
      const queue = new AdminOrdersService(
        prisma as never,
        fakeConfig() as never,
      );

      const res = await queue.list({
        status: 'pending_payment,paid',
        search: `it-${run}-count-`,
        limit: 1,
      });

      expect(res.meta.totalItems).toBe(2);
      expect([waiting.id, paid.id]).toContain(res.data[0].id);
    });
  });

  describe('statuses and races', () => {
    it.each([
      ['refunded', OrderStatus.PAID],
      ['expired', OrderStatus.PENDING_PAYMENT],
    ] as const)('an operator cannot set %s by hand', async (target, from) => {
      const o = await order(`system-${target}`, PaymentType.CASH, false, from);

      await expect(
        orders.updateStatus(o.id, { status: target }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await statusOf(o.id)).toBe(from);
    });

    it('of two concurrent writes one wins: one history row, one notification', async () => {
      const o = await order('race', PaymentType.CASH, false, OrderStatus.PAID);

      const results = await Promise.allSettled([
        orders.updateStatus(o.id, { status: 'processing' }, actor),
        orders.updateStatus(o.id, { status: 'cancelled', note: 'x' }, actor),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId: o.id },
      });
      expect(history).toHaveLength(1);
      expect(notifications.emit).toHaveBeenCalledTimes(1);
    });

    it('a failed notification does not report a committed transition as failed', async () => {
      const o = await order(
        'notify',
        PaymentType.CASH,
        false,
        OrderStatus.PAID,
      );
      notifications.emit.mockRejectedValueOnce(new Error('inbox down'));

      const res = await orders.updateStatus(
        o.id,
        { status: 'processing' },
        actor,
      );

      expect(res.status).toBe('processing');
      expect(await statusOf(o.id)).toBe(OrderStatus.PROCESSING);
    });

    it('re-sending the current status changes nothing', async () => {
      const o = await order(
        'idempotent',
        PaymentType.CASH,
        false,
        OrderStatus.PAID,
      );

      await orders.updateStatus(o.id, { status: 'paid' }, actor);

      const history = await prisma.orderStatusHistory.count({
        where: { orderId: o.id },
      });
      expect(history).toBe(0);
      expect(notifications.emit).not.toHaveBeenCalled();
    });
  });
});
