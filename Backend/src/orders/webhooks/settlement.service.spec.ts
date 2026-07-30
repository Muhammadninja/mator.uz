/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Settlement invariants around a Payme PerformTransaction: the money movement is
 * committed atomically, notification transports are best-effort, and a repeat
 * settlement is a no-op.
 */
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { SettlementService } from './settlement.service';
import { OrderStatusService } from '../order-status.service';
import {
  createPrismaMock,
  fakeConfig,
  PrismaMock,
} from '../../../test/utils/harness';

describe('SettlementService', () => {
  let prisma: PrismaMock;
  let notifications: { emit: jest.Mock };
  let realtime: { emit: jest.Mock };
  let svc: SettlementService;

  beforeEach(() => {
    prisma = createPrismaMock();
    notifications = { emit: jest.fn().mockResolvedValue(undefined) };
    realtime = { emit: jest.fn() };
    svc = new SettlementService(
      prisma,
      notifications as any,
      realtime as any,
      new OrderStatusService(prisma),
      fakeConfig({ ORDER_TTL_MIN: '30' }),
    );
  });

  const pendingPayment = (over: Partial<any> = {}) => ({
    id: 'pay_1',
    orderId: 'ord_1',
    status: PaymentStatus.PENDING,
    amountUzs: 215000,
    order: { userId: 'usr_1' },
    ...over,
  });

  describe('markPaid', () => {
    it('flips the payment and order inside one transaction', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());

      await svc.markPaid('pay_1', 1_700_000_111_000);

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pay_1' },
          data: expect.objectContaining({
            status: PaymentStatus.PAID,
            providerState: 2,
            providerPerformTime: BigInt(1_700_000_111_000),
          }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: OrderStatus.PAID } }),
      );
      // The audit row is written in the same transaction as the status flip.
      expect(prisma.orderStatusHistory.create).toHaveBeenCalled();
    });

    it('is idempotent — an already-paid payment settles and notifies nothing', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        pendingPayment({ status: PaymentStatus.PAID }),
      );

      await svc.markPaid('pay_1');

      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
      expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('survives a failing push notification — the payment stays settled', async () => {
      // Payme must still receive a success reply: the money has been taken and
      // the settlement is committed, so a broken transport cannot fail the call.
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());
      notifications.emit.mockRejectedValue(new Error('expo push down'));

      await expect(
        svc.markPaid('pay_1', 1_700_000_111_000),
      ).resolves.toBeUndefined();
      expect(prisma.payment.update).toHaveBeenCalled();
    });

    it('survives a failing realtime emit and still sends the push', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());
      realtime.emit.mockImplementation(() => {
        throw new Error('socket gone');
      });

      await expect(svc.markPaid('pay_1')).resolves.toBeUndefined();
      // One transport failing must not suppress the other.
      expect(notifications.emit).toHaveBeenCalled();
    });

    it('propagates a database failure so Payme retries', async () => {
      // The opposite of the notification case: if the settlement itself did not
      // commit, the caller MUST fail so Payme re-sends PerformTransaction.
      prisma.payment.findUnique.mockResolvedValue(pendingPayment());
      prisma.$transaction.mockRejectedValue(new Error('deadlock detected'));

      await expect(svc.markPaid('pay_1')).rejects.toThrow('deadlock detected');
    });

    it('ignores an unknown payment id', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      await expect(svc.markPaid('nope')).resolves.toBeUndefined();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });
  });

  describe('markCancelled', () => {
    it('cancels an unperformed payment but leaves the order payable', async () => {
      // The customer never paid, so the order must survive: they can retry with
      // Click or with a fresh Payme transaction.
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay_1',
        orderId: 'ord_1',
        status: PaymentStatus.PENDING,
      });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      await svc.markCancelled('pay_1', 4, false);

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentStatus.CANCELLED,
            providerState: -1,
            cancelReason: 4,
          }),
        }),
      );
      // The order is neither cancelled nor given a status-history row.
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });

    it('grants a fresh payment window when releasing the order', async () => {
      // `expiresAt` is long past by now (our TTL is minutes, Payme's transaction
      // lifetime is 12 hours); without a new window the sweeper would expire the
      // order on its very next pass, making the retry impossible.
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay_1',
        orderId: 'ord_1',
        status: PaymentStatus.PENDING,
      });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      const before = Date.now();
      await svc.markCancelled('pay_1', 4, false);

      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ord_1', status: OrderStatus.PENDING_PAYMENT },
        }),
      );
      const { data } = prisma.order.updateMany.mock.calls[0][0];
      expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 29 * 60_000,
      );
    });

    it('leaves an order that already moved on untouched', async () => {
      // Status-guarded: a 0 count means the order was paid via the other
      // provider or cancelled by an operator in the meantime.
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay_1',
        orderId: 'ord_1',
        status: PaymentStatus.PENDING,
      });
      prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        svc.markCancelled('pay_1', 4, false),
      ).resolves.toBeUndefined();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('marks a refund as REFUNDED on both the payment and the order', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay_1',
        orderId: 'ord_1',
        status: PaymentStatus.PAID,
      });

      await svc.markCancelled('pay_1', 5, true);

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentStatus.REFUNDED,
            providerState: -2,
          }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: OrderStatus.REFUNDED } }),
      );
    });

    it('releases the order on a 12h timeout without expiring it', async () => {
      // The Payme timeout path calls markCancelled(reason 4, performedBefore
      // false). The order must stay PENDING_PAYMENT — a timed-out Payme
      // transaction is not a reason to kill the order, only to free it.
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay_1',
        orderId: 'ord_1',
        status: PaymentStatus.PENDING,
      });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      await svc.markCancelled('pay_1', 4, false);

      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cancelReason: 4 }),
        }),
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ord_1', status: OrderStatus.PENDING_PAYMENT },
        }),
      );
    });

    it('is idempotent — a repeated cancel writes no second history row', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay_1',
        orderId: 'ord_1',
        status: PaymentStatus.CANCELLED,
      });

      await svc.markCancelled('pay_1', 4, false);

      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });
  });
});
