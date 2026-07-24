// Unit tests for the single order-status chokepoint. Prisma is mocked — no DB.
// These guard the core invariant: every path writes both the status change AND
// a history row, atomically; actors are snapshotted; and the sweeper only writes
// an EXPIRED history row when it actually flips a still-pending order.

import { OrderActorType, OrderStatus } from '@prisma/client';
import { OrderStatusService } from './order-status.service';

function makePrismaMock() {
  const order = { update: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() };
  const orderStatusHistory = { create: jest.fn() };
  const prisma: Record<string, unknown> = { order, orderStatusHistory };
  prisma.$transaction = jest.fn((arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(prisma),
  );
  return prisma as {
    order: typeof order;
    orderStatusHistory: typeof orderStatusHistory;
    $transaction: jest.Mock;
  };
}

describe('OrderStatusService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: OrderStatusService;

  beforeEach(() => {
    prisma = makePrismaMock();
    prisma.order.update.mockResolvedValue({});
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.orderStatusHistory.create.mockResolvedValue({});
    service = new OrderStatusService(prisma as never);
  });

  describe('transition', () => {
    it('writes the status change AND a history row in one transaction', async () => {
      await service.transition('ord_1', OrderStatus.PAID, { note: 'Payment received' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'ord_1' },
        data: { status: OrderStatus.PAID },
      });
      expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'ord_1',
          status: OrderStatus.PAID,
          note: 'Payment received',
          actorType: OrderActorType.SYSTEM,
          actorId: null,
          actorName: null,
        }),
      });
      const arg = prisma.orderStatusHistory.create.mock.calls[0][0] as { data: { id: string } };
      expect(arg.data.id).toMatch(/^osh_/);
    });

    it('enlists in a caller-provided transaction instead of opening its own', async () => {
      const tx = {
        order: { update: jest.fn().mockResolvedValue({}) },
        orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      };

      await service.transition('ord_1', OrderStatus.PAID, { tx: tx as never });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.order.update).toHaveBeenCalledWith({
        where: { id: 'ord_1' },
        data: { status: OrderStatus.PAID },
      });
      expect(tx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
    });

    it('snapshots an ADMIN actor (id + display name)', async () => {
      await service.transition('ord_1', OrderStatus.PROCESSING, {
        actor: { id: 'usr_admin', role: 'ADMIN', displayName: 'Operator One' },
      });

      expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorType: OrderActorType.ADMIN,
          actorId: 'usr_admin',
          actorName: 'Operator One',
        }),
      });
    });

    it('falls back to OPERATOR for a non-admin role and derives name from first+last', async () => {
      await service.transition('ord_1', OrderStatus.PROCESSING, {
        actor: { id: 'usr_x', role: 'SELLER', firstName: 'Ali', lastName: 'Valiyev' },
      });

      expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorType: OrderActorType.OPERATOR,
          actorId: 'usr_x',
          actorName: 'Ali Valiyev',
        }),
      });
    });
  });

  describe('recordCreation', () => {
    it('writes the opening history row on the provided tx', async () => {
      const tx = { orderStatusHistory: { create: jest.fn().mockResolvedValue({}) } };

      await service.recordCreation(tx as never, 'ord_1');

      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'ord_1',
          status: OrderStatus.PENDING_PAYMENT,
          note: 'Order created',
          actorType: OrderActorType.SYSTEM,
        }),
      });
    });
  });

  describe('expireOverdue', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');

    it('expires only rows still pending and writes one history row each', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'ord_1' }, { id: 'ord_2' }]);
      // ord_1 still pending (flips), ord_2 was paid since the scan (no-op).
      prisma.order.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      const expired = await service.expireOverdue(now);

      expect(expired).toBe(1);
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord_1', status: OrderStatus.PENDING_PAYMENT },
        data: { status: OrderStatus.EXPIRED },
      });
      expect(prisma.orderStatusHistory.create).toHaveBeenCalledTimes(1);
      expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ orderId: 'ord_1', status: OrderStatus.EXPIRED }),
      });
    });

    it('does nothing when there are no overdue orders', async () => {
      prisma.order.findMany.mockResolvedValue([]);

      expect(await service.expireOverdue(now)).toBe(0);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });
  });
});
