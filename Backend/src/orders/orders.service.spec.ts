/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// OrdersService unit tests (Prisma mocked — no DB).

import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';
import { OrderStatusService } from './order-status.service';
import {
  buildOrder,
  createPrismaMock,
  fakeConfig,
  PrismaMock,
} from '../../test/utils/harness';

function build(prisma: PrismaMock) {
  const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
  const realtime = { emit: jest.fn() };
  const svc = new OrdersService(
    prisma,
    fakeConfig(),
    notifications as any,
    realtime as any,
    new OrderStatusService(prisma),
    {} as any,
  );
  return { svc, notifications, realtime };
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
      svc.updateStatus('ord_1', { status: 'cancelled' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(notifications.emit).not.toHaveBeenCalled();
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
