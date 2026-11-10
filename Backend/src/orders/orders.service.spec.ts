/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// OrdersService unit tests (Prisma mocked — no DB).

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  AdminRole,
  OrderStatus,
  PaymentType,
} from '@prisma/client';
import { OrdersService } from './orders.service';
import { OrderStatusService } from './order-status.service';
import {
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeDeliveryQuotes,
  PrismaMock,
} from '../../test/utils/harness';

function build(prisma: PrismaMock) {
  const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
  const realtime = { emit: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new OrdersService(
    prisma,
    fakeConfig(),
    notifications as any,
    realtime as any,
    new OrderStatusService(prisma),
    {} as any,
    audit as any,
    fakeDeliveryQuotes(),
  );
  return { svc, notifications, realtime, audit };
}

describe('OrdersService.updateStatus (operator write)', () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.order.findUniqueOrThrow = jest.fn();
  });

  it('moves the order conditionally on the status it validated against', async () => {
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({ id: 'ord_1', status: OrderStatus.PAID }),
    );
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUniqueOrThrow.mockResolvedValue(
      buildOrder({ id: 'ord_1', status: OrderStatus.PROCESSING }),
    );
    const { svc, notifications } = build(prisma);

    await svc.updateStatus('ord_1', { status: 'processing' });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord_1', status: { in: [OrderStatus.PAID] } },
      data: { status: OrderStatus.PROCESSING },
    });
    expect(notifications.emit).toHaveBeenCalledTimes(1);
  });

  it('409s instead of overwriting a status that changed meanwhile (e.g. a payment landed)', async () => {
    // Read as PENDING_PAYMENT; by the time the cancel is written, a payment
    // has moved the order to PAID — the guarded write matches nothing.
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({ id: 'ord_1', status: OrderStatus.PENDING_PAYMENT }),
    );
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    const { svc, notifications } = build(prisma);

    await expect(
      svc.updateStatus('ord_1', { status: 'cancelled', note: 'Out of stock' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it.each(['refunded', 'expired'])(
    'refuses %s: only the system sets it, even where the table has the edge',
    async (status) => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({
          id: 'ord_1',
          status:
            status === 'refunded'
              ? OrderStatus.PAID
              : OrderStatus.PENDING_PAYMENT,
        }),
      );
      const { svc } = build(prisma);

      await expect(
        svc.updateStatus('ord_1', { status }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    },
  );

  describe('cancelling', () => {
    it('needs a reason, whatever the client sent', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', status: OrderStatus.PAID }),
      );
      const { svc } = build(prisma);

      await expect(
        svc.updateStatus('ord_1', { status: 'cancelled', note: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('takes the reason from either field and audits who cancelled what', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', status: OrderStatus.PAID }),
      );
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        buildOrder({ id: 'ord_1', status: OrderStatus.CANCELLED }),
      );
      const { svc, audit } = build(prisma);

      await svc.updateStatus(
        'ord_1',
        { status: 'cancelled', reason: 'Out of stock' },
        { id: 'adm_1', email: 'a@m.uz', displayName: 'A', role: 'ADMIN' },
      );

      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AdminAuditAction.ORDER_CANCELLED,
        actor: { id: 'adm_1', email: 'a@m.uz' },
        reason: 'Out of stock',
        previousValues: { status: OrderStatus.PAID },
        newValues: { status: OrderStatus.CANCELLED },
      });
    });
  });

  // INFO-6: the active-transaction check is repeated under the order lock that
  // Payme's CreateTransaction also takes.
  describe('manual payment vs a Payme transaction', () => {
    const manager = {
      id: 'adm_mg',
      role: 'ADMIN',
      adminRole: AdminRole.MANAGER,
      email: 'mg@m.uz',
      displayName: 'Mg',
    };
    const payme = (providerState: number | null) => ({
      id: 'pay_1',
      provider: 'PAYME',
      status: 'PENDING',
      providerState,
      providerTransactionId: 'ptx_1',
    });

    beforeEach(() => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({
          id: 'ord_1',
          status: OrderStatus.PENDING_PAYMENT,
          paymentType: PaymentType.PAYME,
        }),
      );
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        buildOrder({ id: 'ord_1', status: OrderStatus.PAID }),
      );
    });

    it('a transaction Payme created after the first check is seen under the lock and wins', async () => {
      // First read (outside): nothing active. Second read (under the lock): the
      // CreateTransaction that committed in between.
      prisma.payment.findMany
        .mockResolvedValueOnce([payme(null)])
        .mockResolvedValueOnce([payme(1)]);
      const { svc, audit } = build(prisma);

      await expect(
        svc.updateStatus(
          'ord_1',
          { status: 'paid', note: 'Bank statement 14:05' },
          manager,
        ),
      ).rejects.toMatchObject({ response: { code: 'PAYMENT_IN_PROGRESS' } });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('locks the order before re-reading payments and moving it', async () => {
      prisma.payment.findMany.mockResolvedValue([payme(null)]);
      const { svc } = build(prisma);

      await svc.updateStatus(
        'ord_1',
        { status: 'paid', note: 'Bank statement 14:05' },
        manager,
      );

      const lockCall = prisma.$queryRaw.mock.calls.findIndex((c: any[]) =>
        c[0].join('?').includes('FROM orders WHERE id = ? FOR UPDATE'),
      );
      expect(lockCall).toBeGreaterThanOrEqual(0);
      expect(prisma.$queryRaw.mock.invocationCallOrder[lockCall]).toBeLessThan(
        prisma.payment.findMany.mock.invocationCallOrder[1],
      );
      expect(prisma.payment.findMany.mock.invocationCallOrder[1]).toBeLessThan(
        prisma.order.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('when Payme performed first, the manual move finds the order moved and changes nothing', async () => {
      prisma.payment.findMany.mockResolvedValue([payme(null)]);
      // PerformTransaction's conditional move already took the order to PAID.
      prisma.order.updateMany.mockResolvedValue({ count: 0 });
      const { svc, audit } = build(prisma);

      await expect(
        svc.updateStatus(
          'ord_1',
          { status: 'paid', note: 'Bank statement 14:05' },
          manager,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      // No second "paid" history row, no payment-confirmed audit entry.
      expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('marking an order paid by hand', () => {
    const operator = {
      id: 'adm_op',
      role: 'ADMIN',
      adminRole: AdminRole.OPERATOR,
      email: 'op@m.uz',
      displayName: 'Op',
    };
    const manager = { ...operator, id: 'adm_mg', adminRole: AdminRole.MANAGER };
    const pending = (paymentType: PaymentType | null) => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({
          id: 'ord_1',
          status: OrderStatus.PENDING_PAYMENT,
          paymentType,
        }),
      );
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        buildOrder({ id: 'ord_1', status: OrderStatus.PAID }),
      );
    };

    it.each([PaymentType.CASH, PaymentType.TERMINAL, null])(
      'an operator may confirm a %s order with no payment on file: that is the flow',
      async (paymentType) => {
        pending(paymentType);
        const { svc, audit } = build(prisma);

        await svc.updateStatus('ord_1', { status: 'paid' }, operator);

        expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
        expect(audit.record.mock.calls[0][0].action).toBe(
          AdminAuditAction.ORDER_PAYMENT_CONFIRMED,
        );
      },
    );

    it('an operator may not confirm an online order, even with a note', async () => {
      pending(PaymentType.PAYME);
      const { svc } = build(prisma);

      await expect(
        svc.updateStatus('ord_1', { status: 'paid', note: 'x' }, operator),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('nor an order with no method recorded once it has a payment row', async () => {
      pending(null);
      prisma.payment.findMany.mockResolvedValue([
        { id: 'p1', provider: 'PAYME', status: 'PENDING', providerState: null },
      ]);
      const { svc } = build(prisma);

      await expect(
        svc.updateStatus('ord_1', { status: 'paid', note: 'x' }, operator),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a stale payment row does not make a cash order online', async () => {
      pending(PaymentType.CASH);
      prisma.payment.findMany.mockResolvedValue([
        { id: 'p1', provider: 'PAYME', status: 'CANCELLED', providerState: -1 },
      ]);
      const { svc } = build(prisma);

      await svc.updateStatus('ord_1', { status: 'paid' }, operator);

      expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    });

    it('a manager needs a note, and it reaches the history and the audit trail', async () => {
      pending(PaymentType.PAYME);
      const { svc, audit } = build(prisma);

      await expect(
        svc.updateStatus('ord_1', { status: 'paid', note: '   ' }, manager),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();

      await svc.updateStatus(
        'ord_1',
        {
          status: 'paid',
          note: 'Reconciled against the Payme cabinet',
          paymentReference: 'PM-77',
        },
        manager,
      );

      expect(prisma.orderStatusHistory.create.mock.calls[0][0].data.note).toBe(
        'Reconciled against the Payme cabinet [PM-77]',
      );
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        actor: { id: 'adm_mg' },
        reason: 'Reconciled against the Payme cabinet',
        newValues: { paymentReference: 'PM-77' },
      });
    });

    it('nobody may confirm while a provider transaction is live, not even a manager', async () => {
      pending(PaymentType.PAYME);
      prisma.payment.findMany.mockResolvedValue([
        { id: 'p1', provider: 'PAYME', status: 'PENDING', providerState: 1 },
      ]);
      const { svc } = build(prisma);

      await expect(
        svc.updateStatus('ord_1', { status: 'paid', note: 'x' }, manager),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
  });

  it('reports a committed transition as done even when the notification fails', async () => {
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({ id: 'ord_1', status: OrderStatus.PAID }),
    );
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUniqueOrThrow.mockResolvedValue(
      buildOrder({ id: 'ord_1', status: OrderStatus.PROCESSING }),
    );
    const { svc, notifications } = build(prisma);
    notifications.emit.mockRejectedValue(new Error('inbox write failed'));

    const res = await svc.updateStatus('ord_1', { status: 'processing' });

    expect(res.status).toBe('processing');
  });

  it('still rejects an illegal jump with 400', async () => {
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({ id: 'ord_1', status: OrderStatus.CANCELLED }),
    );
    const { svc } = build(prisma);
    await expect(
      svc.updateStatus('ord_1', { status: 'paid' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });
});
