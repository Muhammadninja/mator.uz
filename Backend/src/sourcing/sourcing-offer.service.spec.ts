// Unit tests for SourcingOfferService.
//
// Contract pinned here:
//   • an offer is persisted and the ticket advances PENDING/IN_PROGRESS → OFFERED
//   • a price-only offer (no image) is first-class — images may be empty
//   • the customer is notified ONLY when the ticket is owned by a real AppUser
//   • notification failure / anonymous owner NEVER fails offer creation
//   • a missing ticket throws NotFoundException

import { ConflictException, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { SourcingOfferService } from './sourcing-offer.service';

const TICKET = {
  id: 'ticket-1',
  userId: 'usr_1',
  status: 'PENDING',
  extractedData: { part_name: 'Тормозные колодки' },
};

const OWNED_OFFER = {
  id: 'soff_1',
  ticketId: 'ticket-1',
  price: 250000,
  currency: 'UZS',
  images: ['https://cdn/img1.jpg'],
  status: 'SENT',
  sellerTgId: '99',
  ticket: { userId: 'usr_1', extractedData: { part_name: 'Тормозные колодки' } },
};

/** Behaves like the table for what delivery relies on: claiming is exclusive. */
function offerStore(overrides: Record<string, any>) {
  let created: Record<string, any> | null = null;
  return {
    create: jest.fn(async ({ data }: { data: Record<string, any> }) => (created = { ...data })),
    findUnique: jest.fn(async () =>
      created
        ? {
            ...created,
            ticket: await overrides.sourcingTicket?.findUnique() ?? OWNED_OFFER.ticket,
          }
        : OWNED_OFFER,
    ),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, any>; data: any }) => {
      if (created && where.customerNotifyPending === true && !created.customerNotifyPending) {
        return { count: 0 };
      }
      if (created) Object.assign(created, data);
      return { count: 1 };
    }),
  };
}

function makePrisma(overrides: Record<string, unknown> = {}) {
  const prisma: Record<string, any> = {
    // The ticket row lock taken by acceptOffer; its status decides.
    $queryRaw: jest.fn(async () => [{ status: 'OFFERED' }]),
    $transaction: jest.fn((run: (tx: unknown) => unknown) => run(prisma)),
    sourcingTicket: {
      findUnique: jest.fn(async () => TICKET),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => TICKET),
    },
    sourcingOffer: offerStore(overrides),
    appUser: {
      findUnique: jest.fn(async () => ({ id: 'usr_1' })),
    },
    ...overrides,
  };
  return prisma as any;
}

function build(prisma = makePrisma()) {
  const notifications = { emit: jest.fn(async () => ({ id: 'ntf_1' })) };
  const cart = {
    addSourcedOffer: jest.fn(async () => ({ items: [], subtotalUzs: 250000 })),
    addSourcedOfferLine: jest.fn(async () => undefined),
    snapshot: jest.fn(async () => ({ items: [], subtotalUzs: 250000 })),
  };
  const telegram = {
    notifyDealerOfferAccepted: jest.fn(async () => undefined),
    notifyDealerOfferDeclined: jest.fn(async () => undefined),
  };
  const service = new SourcingOfferService(
    prisma as never,
    notifications as never,
    cart as never,
    telegram as never,
    { offerTtlMs: 3_600_000 } as never,
  );
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
  return { service, prisma, notifications, cart, telegram };
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

  it('never fails offer creation when notification throws, and keeps it owed', async () => {
    const { service, prisma, notifications } = build();
    notifications.emit.mockRejectedValueOnce(new Error('inbox down'));

    const offer = await service.createOffer(baseInput);

    expect(offer.price).toBe(250000);
    expect(prisma.sourcingOffer.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { customerNotifyPending: true } }),
    );
  });

  it('sets an expiry on new offers', async () => {
    const { service, prisma } = build();
    await service.createOffer(baseInput);
    const data = prisma.sourcingOffer.create.mock.calls[0][0].data;
    expect((data.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not deliver twice when two runs overlap', async () => {
    const { service, notifications } = build();
    await service.createOffer(baseInput);
    await service.deliverOfferNotification('any');
    expect(notifications.emit).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundException for a missing ticket', async () => {
    const prisma = makePrisma({
      sourcingTicket: { findUnique: jest.fn(async () => null), updateMany: jest.fn() },
    });
    const { service } = build(prisma);

    await expect(service.createOffer(baseInput)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SourcingOfferService.acceptOffer', () => {
  it('adds the offer to the cart and marks offer + ticket ACCEPTED', async () => {
    const { service, prisma, cart } = build();

    const snapshot = await service.acceptOffer('soff_1', 'usr_1');

    expect(prisma.sourcingOffer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'soff_1', status: 'SENT' }),
        data: { status: 'ACCEPTED', customerNotifyPending: false },
      }),
    );
    // Written on the acceptance's own transaction.
    expect(cart.addSourcedOfferLine).toHaveBeenCalledWith(
      prisma,
      'usr_1',
      expect.objectContaining({ offerId: 'soff_1', priceUzs: 250000, title: 'Тормозные колодки' }),
    );
    expect(prisma.sourcingTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ACCEPTED' } }),
    );
    expect(snapshot).toMatchObject({ subtotalUzs: 250000 });
  });

  it('notifies the dealer their offer was accepted', async () => {
    const { service, telegram } = build();
    await service.acceptOffer('soff_1', 'usr_1');
    expect(telegram.notifyDealerOfferAccepted).toHaveBeenCalledWith(
      '99',
      'Тормозные колодки',
      expect.stringContaining('UZS'),
    );
  });

  it('is idempotent-safe: a non-SENT offer (flip count 0) → Conflict, no cart write', async () => {
    const prisma = makePrisma({
      sourcingOffer: {
        findUnique: jest.fn(async () => OWNED_OFFER),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    });
    const { service, cart } = build(prisma);

    await expect(service.acceptOffer('soff_1', 'usr_1')).rejects.toBeInstanceOf(ConflictException);
    expect(cart.addSourcedOfferLine).not.toHaveBeenCalled();
  });

  it('rejects an offer the caller does not own', async () => {
    const prisma = makePrisma({
      sourcingOffer: {
        findUnique: jest.fn(async () => ({ ...OWNED_OFFER, ticket: { userId: 'someone-else' } })),
        updateMany: jest.fn(),
      },
    });
    const { service } = build(prisma);

    await expect(service.acceptOffer('soff_1', 'usr_1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SourcingOfferService.acceptOffer — ticket state and races (LOW-ORD-011)', () => {
  it.each(['CLOSED', 'CANCELLED', 'ACCEPTED'])(
    'a %s ticket accepts no offer and is not reopened',
    async (status) => {
      const { service, prisma, cart, telegram } = build();
      prisma.$queryRaw.mockResolvedValue([{ status }]);

      await expect(service.acceptOffer('soff_1', 'usr_1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.sourcingOffer.updateMany).not.toHaveBeenCalled();
      expect(prisma.sourcingTicket.update).not.toHaveBeenCalled();
      expect(cart.addSourcedOfferLine).not.toHaveBeenCalled();
      expect(telegram.notifyDealerOfferAccepted).not.toHaveBeenCalled();
    },
  );

  it.each(['PENDING', 'IN_PROGRESS', 'OFFERED', 'NO_OFFER'])(
    'a %s ticket can still accept an offer',
    async (status) => {
      const { service, prisma } = build();
      prisma.$queryRaw.mockResolvedValue([{ status }]);
      await expect(service.acceptOffer('soff_1', 'usr_1')).resolves.toBeDefined();
    },
  );

  it('locks the ticket row before deciding', async () => {
    const { service, prisma } = build();
    await service.acceptOffer('soff_1', 'usr_1');
    const sql = (prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray])[0].join('?');
    expect(sql).toMatch(/FROM sourcing_tickets\s+WHERE id = \?::uuid FOR UPDATE/);
  });

  it('two dealers\' offers on one ticket accepted at once: one wins, the other is refused', async () => {
    const { service, prisma, cart, telegram } = build();
    // Stand-in for the row lock: one transaction at a time, each reading what
    // the previous one committed.
    let ticketStatus = 'OFFERED';
    let queue: Promise<unknown> = Promise.resolve();
    prisma.$transaction.mockImplementation((run: (tx: unknown) => Promise<unknown>) => {
      const next = queue.then(() => run(prisma));
      queue = next.catch(() => undefined);
      return next;
    });
    prisma.$queryRaw.mockImplementation(async () => [{ status: ticketStatus }]);
    prisma.sourcingTicket.update.mockImplementation(async (a: any) => {
      ticketStatus = a.data.status;
      return {};
    });

    const results = await Promise.allSettled([
      service.acceptOffer('soff_1', 'usr_1'),
      service.acceptOffer('soff_2', 'usr_1'),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(cart.addSourcedOfferLine).toHaveBeenCalledTimes(1);
    expect(telegram.notifyDealerOfferAccepted).toHaveBeenCalledTimes(1);
  });

  it('a failed cart write rolls the acceptance back and tells no dealer', async () => {
    const { service, cart, telegram } = build();
    cart.addSourcedOfferLine.mockRejectedValue(new Error('db blip'));
    await expect(service.acceptOffer('soff_1', 'usr_1')).rejects.toThrow('db blip');
    expect(telegram.notifyDealerOfferAccepted).not.toHaveBeenCalled();
  });
});

describe('SourcingOfferService.rejectOffer', () => {
  it('declines with a reason (ticket left untouched)', async () => {
    const { service, prisma } = build();

    const res = await service.rejectOffer('soff_1', 'usr_1', 'TOO_EXPENSIVE', 'дорого');

    expect(prisma.sourcingOffer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'soff_1', status: 'SENT' },
        data: expect.objectContaining({ status: 'DECLINED', declineReason: 'TOO_EXPENSIVE', declineNote: 'дорого' }),
      }),
    );
    expect(prisma.sourcingTicket.update).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true });
  });

  it('notifies the dealer their offer was declined + reason', async () => {
    const { service, telegram } = build();
    await service.rejectOffer('soff_1', 'usr_1', 'TOO_EXPENSIVE');
    expect(telegram.notifyDealerOfferDeclined).toHaveBeenCalledWith(
      '99',
      'Тормозные колодки',
      'слишком дорого',
    );
  });

  it('conflicts when the offer is no longer SENT', async () => {
    const prisma = makePrisma({
      sourcingOffer: {
        findUnique: jest.fn(async () => OWNED_OFFER),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    });
    const { service } = build(prisma);

    await expect(
      service.rejectOffer('soff_1', 'usr_1', 'OTHER'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('SourcingOfferService — expiry', () => {
  it('will not accept an expired offer', async () => {
    const { service, prisma, cart } = build();
    prisma.sourcingOffer.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.acceptOffer('soff_1', 'usr_1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.sourcingOffer.updateMany.mock.calls[0][0].where.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);
    expect(cart.addSourcedOfferLine).not.toHaveBeenCalled();
  });
});
