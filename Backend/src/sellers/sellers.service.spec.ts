// Tests for SellersService.updateStatus — specifically the "seller approved"
// domain event that drives the Telegram approval notification.
//
// The contract under test: the event fires on a real transition INTO ACTIVE, once,
// after the row is written, and never for any other status change. Whether the
// notification is delivered is the LISTENER's problem (see telegram.service);
// nothing here waits on it.

import { NotFoundException } from '@nestjs/common';
import { SellerStatus } from '@prisma/client';
import { Reflector } from '@nestjs/core';
import { SELLER_STATUS_TRANSITIONS, SellersService } from './sellers.service';
import { AdminController } from '../admin/admin.controller';
import { QueueHealthController } from '../ops/queue-health.controller';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { SellerEvent } from './seller-events';

function makePrisma(seller: Record<string, unknown> | null) {
  const prisma = {
    // The row lock taken before the status is read.
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: (run: (tx: unknown) => unknown) => run(prisma),
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
  return prisma;
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

  it('does not approve a REJECTED seller in one call, and messages nobody', async () => {
    const { svc, prisma, events } = makeService({
      ...pendingSeller,
      status: SellerStatus.REJECTED,
    });

    await expect(svc.updateStatus(7, SellerStatus.ACTIVE)).rejects.toMatchObject(
      {
        status: 409,
        response: { code: 'SELLER_STATUS_TRANSITION_NOT_ALLOWED' },
      },
    );
    expect(prisma.seller.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
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

describe('SellersService — TELEGRAM vs BUSINESS sellers', () => {
  it('onboarding through the bot always creates a TELEGRAM seller with its tgId and phone', async () => {
    const { svc, prisma } = makeService(null);

    await svc.upsertFromBot(BigInt(555), 'Avtomir', '+998901234567');

    expect(prisma.seller.upsert).toHaveBeenCalledWith({
      where: { tgId: BigInt(555) },
      update: {},
      create: {
        sellerType: 'TELEGRAM',
        tgId: BigInt(555),
        storeName: 'Avtomir',
        phone: '+998901234567',
        status: SellerStatus.PENDING,
      },
    });
  });

  it('approving a BUSINESS seller (no Telegram account) changes the status but sends no Telegram notice', async () => {
    const business = { id: 9, sellerType: 'BUSINESS', tgId: null, phone: null, status: SellerStatus.PENDING };
    const { svc, prisma, events } = makeService(business);

    const result = await svc.updateStatus(9, SellerStatus.ACTIVE);

    expect(prisma.seller.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { status: SellerStatus.ACTIVE } });
    expect(result).toMatchObject({ id: 9, status: SellerStatus.ACTIVE });
    expect(events.emit).not.toHaveBeenCalled();
  });
});

// LOW-ADM-010: the explicit transition table, decided under a row lock.
describe('SellersService.updateStatus — transitions', () => {
  const { PENDING, ACTIVE, REJECTED } = SellerStatus;
  const withStatus = (status: SellerStatus) => ({ ...pendingSeller, status });

  it.each([
    [PENDING, ACTIVE],
    [PENDING, REJECTED],
    [ACTIVE, REJECTED],
  ])('%s -> %s is allowed and written', async (from, to) => {
    const { svc, prisma } = makeService(withStatus(from));
    await expect(svc.updateStatus(7, to)).resolves.toMatchObject({ status: to });
    expect(prisma.seller.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { status: to },
    });
  });

  it.each([
    [REJECTED, ACTIVE],
    [REJECTED, PENDING],
    [ACTIVE, PENDING],
  ])('%s -> %s is refused with 409 and nothing is written', async (from, to) => {
    const { svc, prisma } = makeService(withStatus(from));
    await expect(svc.updateStatus(7, to)).rejects.toMatchObject({ status: 409 });
    expect(prisma.seller.update).not.toHaveBeenCalled();
  });

  it.each([PENDING, ACTIVE, REJECTED])(
    'asking for the current status (%s) is an idempotent no-op',
    async (status) => {
      const { svc, prisma, events } = makeService(withStatus(status));
      await expect(svc.updateStatus(7, status)).resolves.toMatchObject({
        status,
      });
      expect(prisma.seller.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    },
  );

  it('the table covers every status, so a new one cannot be forgotten', () => {
    expect(Object.keys(SELLER_STATUS_TRANSITIONS).sort()).toEqual(
      Object.values(SellerStatus).sort(),
    );
  });

  it('locks the row before reading the status it decides on', async () => {
    const { svc, prisma } = makeService(pendingSeller);
    await svc.updateStatus(7, ACTIVE);
    const sql = (
      prisma.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray]
    )[0].join('?');
    expect(sql).toMatch(/FROM sellers WHERE id = \? FOR UPDATE/);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.seller.findUnique.mock.invocationCallOrder[0],
    );
  });

  it('a concurrent approve and reject cannot both apply to the PENDING row', async () => {
    // What the row lock produces: the second caller reads what the first wrote.
    const { svc, prisma, events } = makeService(pendingSeller);
    // Stand-in for `SELECT … FOR UPDATE`: one transaction at a time.
    let queue: Promise<unknown> = Promise.resolve();
    (prisma as { $transaction: unknown }).$transaction = (
      run: (tx: unknown) => Promise<unknown>,
    ) => {
      const next = queue.then(() => run(prisma));
      queue = next.catch(() => undefined);
      return next;
    };
    let current: SellerStatus = PENDING;
    prisma.seller.findUnique.mockImplementation(async () => ({
      ...pendingSeller,
      status: current,
    }));
    prisma.seller.update.mockImplementation(
      async (args: { data: { status: SellerStatus } }) => {
        current = args.data.status;
        return { ...pendingSeller, status: current };
      },
    );

    const results = await Promise.allSettled([
      svc.updateStatus(7, REJECTED),
      svc.updateStatus(7, ACTIVE),
    ]);

    // Rejection won; the approval was judged against REJECTED and refused.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(current).toBe(REJECTED);
    expect(events.emit).not.toHaveBeenCalled();
  });
});

// The legacy plane keeps its access rule exactly: buyer-JWT Role.ADMIN only.
describe('legacy api/admin plane access (unchanged)', () => {
  const rolesOf = (target: object) =>
    Reflect.getMetadata(ROLES_KEY, target) as string[];

  it('seller approval and the queue-health route still require Role.ADMIN', () => {
    expect(rolesOf(AdminController)).toEqual(['ADMIN']);
    expect(rolesOf(QueueHealthController)).toEqual(['ADMIN']);
  });

  it('a buyer USER is refused by the guard, an ADMIN is let through', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (role: string) =>
      ({
        getHandler: () => AdminController.prototype.approveSeller,
        getClass: () => AdminController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as never;
    expect(guard.canActivate(ctx('USER'))).toBe(false);
    expect(guard.canActivate(ctx('ADMIN'))).toBe(true);
  });
});

// LOW-ING-012: repeated /start never makes a second seller.
describe('SellersService.upsertFromBot', () => {
  it('is keyed on the unique tg_id, so repeated /start finds the same row', async () => {
    const { svc, prisma } = makeService(pendingSeller);
    prisma.seller.upsert.mockResolvedValue(pendingSeller);
    await svc.upsertFromBot(123456n, 'Avtomir');
    await svc.upsertFromBot(123456n, 'Avtomir');
    for (const [args] of prisma.seller.upsert.mock.calls as any[]) {
      expect(args.where).toEqual({ tgId: 123456n });
      expect(args.update).toEqual({});
    }
  });

  it('a concurrent duplicate that loses the insert gets the winner\'s row, not an error', async () => {
    const { svc, prisma } = makeService(pendingSeller);
    const { Prisma } = jest.requireActual<typeof import('@prisma/client')>('@prisma/client');
    prisma.seller.upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    await expect(svc.upsertFromBot(123456n, 'Avtomir')).resolves.toBe(pendingSeller);
    expect(prisma.seller.findUnique).toHaveBeenCalledWith({ where: { tgId: 123456n } });
  });

  it('other database errors still surface', async () => {
    const { svc, prisma } = makeService(pendingSeller);
    prisma.seller.upsert.mockRejectedValue(new Error('db down'));
    await expect(svc.upsertFromBot(123456n, 'Avtomir')).rejects.toThrow('db down');
  });
});
