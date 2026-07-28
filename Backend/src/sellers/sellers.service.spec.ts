// Tests for SellersService.updateStatus — specifically the "seller approved"
// domain event that drives the Telegram approval notification.
//
// The contract under test: the event fires on a real transition INTO ACTIVE, once,
// after the row is written, and never for any other status change. Whether the
// notification is delivered is the LISTENER's problem (see telegram.service);
// nothing here waits on it.

import { NotFoundException } from '@nestjs/common';
import { SellerStatus } from '@prisma/client';
import { SellersService } from './sellers.service';
import { SellerEvent } from './seller-events';

function makePrisma(seller: Record<string, unknown> | null) {
  return {
    seller: {
      findUnique: jest.fn().mockResolvedValue(seller),
      update: jest
        .fn()
        .mockImplementation(
          async (args: {
            where: { id: number };
            data: { status: string };
          }) => ({
            ...seller,
            ...args.data,
          }),
        ),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
  };
}

function makeEvents() {
  return { emit: jest.fn() };
}

const pendingSeller = {
  id: 7,
  tgId: BigInt(123456),
  status: SellerStatus.PENDING,
  storeName: 'Avtomir',
};

function makeService(
  seller: Record<string, unknown> | null,
  events = makeEvents(),
) {
  const prisma = makePrisma(seller);
  const svc = new SellersService(prisma as never, events as never);
  return { svc, prisma, events };
}

describe('SellersService.updateStatus — approval event', () => {
  it('emits seller.approved with the id and tgId when a PENDING seller is approved', async () => {
    const { svc, events } = makeService(pendingSeller);

    await svc.updateStatus(7, SellerStatus.ACTIVE);

    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(SellerEvent.APPROVED, {
      sellerId: 7,
      // tgId doubles as the Telegram chat id the listener messages.
      tgId: BigInt(123456),
    });
  });

  it('emits only AFTER the row is written (approval is the fact, the notice follows)', async () => {
    const order: string[] = [];
    const events = { emit: jest.fn(() => void order.push('emit')) };
    const { svc, prisma } = makeService(pendingSeller, events);
    prisma.seller.update.mockImplementation(async () => {
      order.push('update');
      return { ...pendingSeller, status: SellerStatus.ACTIVE };
    });

    await svc.updateStatus(7, SellerStatus.ACTIVE);

    expect(order).toEqual(['update', 'emit']);
  });

  it('does NOT re-emit when an already-ACTIVE seller is approved again', async () => {
    // An idempotent admin retry or a double-click must not message the seller twice.
    const { svc, events } = makeService({
      ...pendingSeller,
      status: SellerStatus.ACTIVE,
    });

    await svc.updateStatus(7, SellerStatus.ACTIVE);

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not emit on rejection or any other status change', async () => {
    const { svc, events } = makeService(pendingSeller);

    await svc.updateStatus(7, SellerStatus.REJECTED);

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('emits when a REJECTED seller is later approved (a real transition)', async () => {
    const { svc, events } = makeService({
      ...pendingSeller,
      status: SellerStatus.REJECTED,
    });

    await svc.updateStatus(7, SellerStatus.ACTIVE);

    expect(events.emit).toHaveBeenCalledWith(SellerEvent.APPROVED, {
      sellerId: 7,
      tgId: BigInt(123456),
    });
  });

  it('throws for an unknown seller and emits nothing', async () => {
    const { svc, events, prisma } = makeService(null);

    await expect(svc.updateStatus(99, SellerStatus.ACTIVE)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.seller.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('returns the UPDATED seller row', async () => {
    const { svc } = makeService(pendingSeller);

    const result = await svc.updateStatus(7, SellerStatus.ACTIVE);

    expect(result).toMatchObject({ id: 7, status: SellerStatus.ACTIVE });
  });
});
