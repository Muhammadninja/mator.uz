// Unit tests for SourcingOfferService.
//
// Contract pinned here:
//   • an offer is persisted and the ticket advances PENDING/IN_PROGRESS → OFFERED
//   • a price-only offer (no image) is first-class — images may be empty
//   • the customer is notified ONLY when the ticket is owned by a real AppUser
//   • notification failure / anonymous owner NEVER fails offer creation
//   • a missing ticket throws NotFoundException

import { NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { SourcingOfferService } from './sourcing-offer.service';

const TICKET = {
  id: 'ticket-1',
  userId: 'usr_1',
  status: 'PENDING',
  extractedData: { part_name: 'Тормозные колодки' },
};

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    sourcingTicket: {
      findUnique: jest.fn(async () => TICKET),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    sourcingOffer: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
      })),
      findUnique: jest.fn(),
    },
    appUser: {
      findUnique: jest.fn(async () => ({ id: 'usr_1' })),
    },
    ...overrides,
  };
}

function build(prisma = makePrisma()) {
  const notifications = { emit: jest.fn(async () => ({ id: 'ntf_1' })) };
  const service = new SourcingOfferService(prisma as never, notifications as never);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
  return { service, prisma, notifications };
}

const baseInput = {
  ticketId: 'ticket-1',
  price: 250000,
  sellerTgId: '99',
  sellerUsername: 'dealer1',
};

describe('SourcingOfferService.createOffer', () => {
  it('persists the offer, advances the ticket, and notifies the owner', async () => {
    const { service, prisma, notifications } = build();

    const offer = await service.createOffer({
      ...baseInput,
      condition: 'USED',
      availability: 'IN_STOCK',
      images: ['https://cdn/img1.jpg'],
    });

    expect(prisma.sourcingOffer.create).toHaveBeenCalledTimes(1);
    expect(offer.price).toBe(250000);
    // Only advances from non-terminal states.
    expect(prisma.sourcingTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['PENDING', 'IN_PROGRESS'] } }),
        data: { status: 'OFFERED' },
      }),
    );
    expect(notifications.emit).toHaveBeenCalledWith(
      'usr_1',
      expect.objectContaining({
        type: NotificationType.SOURCING_OFFER,
        deeplinkPath: expect.stringContaining('/sourcing/offer/'),
        data: expect.objectContaining({
          price: 250000,
          imageUrl: 'https://cdn/img1.jpg',
          partName: 'Тормозные колодки',
        }),
      }),
    );
  });

  it('accepts a price-only offer (no image) and sends imageUrl:null', async () => {
    const { service, notifications } = build();

    const offer = await service.createOffer(baseInput);

    expect(offer.images).toEqual([]);
    expect(notifications.emit).toHaveBeenCalledWith(
      'usr_1',
      expect.objectContaining({ data: expect.objectContaining({ imageUrl: null, imagesCount: 0 }) }),
    );
  });

  it('does not notify an anonymous ticket (no userId), but still creates the offer', async () => {
    const prisma = makePrisma({
      sourcingTicket: {
        findUnique: jest.fn(async () => ({ ...TICKET, userId: null })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    });
    const { service, notifications } = build(prisma);

    const offer = await service.createOffer(baseInput);

    expect(offer.price).toBe(250000);
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('skips notification when the ticket owner is not an AppUser', async () => {
    const prisma = makePrisma({
      appUser: { findUnique: jest.fn(async () => null) },
    });
    const { service, notifications } = build(prisma);

    await service.createOffer(baseInput);

    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('never fails offer creation when notification throws', async () => {
    const { service, notifications } = build();
    notifications.emit.mockRejectedValueOnce(new Error('push down'));

    const offer = await service.createOffer(baseInput);

    expect(offer.price).toBe(250000);
  });

  it('throws NotFoundException for a missing ticket', async () => {
    const prisma = makePrisma({
      sourcingTicket: { findUnique: jest.fn(async () => null), updateMany: jest.fn() },
    });
    const { service } = build(prisma);

    await expect(service.createOffer(baseInput)).rejects.toBeInstanceOf(NotFoundException);
  });
});
