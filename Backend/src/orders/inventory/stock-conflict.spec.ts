/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- the Prisma harness is untyped by design */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UnavailableLine } from '../order-availability';
import { StockConflictRefuser, shortageCause } from './stock-conflict';

type Row = Record<string, any>;

const ORIGIN = {
  id: 'part_stock_1',
  title: 'Filter',
  sellerId: 'drivers-village',
  stockQty: 2,
  reservedQty: 0,
  oemNumbers: ['OEM1'],
  gmNumbers: ['GM1'],
  seller: { name: "Driver's Village" },
};

const offer = (over: Row = {}) => ({
  id: 'other',
  title: 'Filter (other)',
  priceUzs: new Prisma.Decimal(1500),
  stockQty: 10,
  reservedQty: 0,
  seller: { name: 'Other Dealer' },
  ...over,
});

function setup(alternatives: Row[] = [], open: Row[] = []) {
  const attempts = new Map<string, Row>();
  const tickets: Row[] = [];
  const tx: Row = {
    stockShortageAttempt: {
      create: jest.fn(async ({ data }: Row) => {
        if (attempts.has(data.dedupeKey)) {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'x',
          });
        }
        attempts.set(data.dedupeKey, {
          ...data,
          attempts: 1,
          sourcingTicketId: null,
        });
        return data;
      }),
      update: jest.fn(async ({ where, data }: Row) => {
        const row = [...attempts.values()].find(
          (a) => a.id === where.id || a.dedupeKey === where.dedupeKey,
        )!;
        if (data.attempts) row.attempts += 1;
        if (data.sourcingTicketId) row.sourcingTicketId = data.sourcingTicketId;
        return row;
      }),
    },
    sourcingTicket: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: Row) => {
        tickets.push(data);
        return { id: data.id };
      }),
    },
    sourcingRequest: { create: jest.fn(async () => ({ id: 'req' })) },
  };
  const findParts = jest.fn(async ({ where }: Row) =>
    where.id?.in ? [ORIGIN] : alternatives,
  );
  const prisma: Row = {
    ...tx,
    $transaction: jest.fn((fn: (t: Row) => unknown) => fn(tx)),
    catalogPart: { findMany: findParts },
    inventoryReservation: { findMany: jest.fn(async () => open) },
    partCategory: { findMany: jest.fn(async () => []) },
    providerServiceOffering: { findMany: jest.fn(async () => []) },
    sourcingOffer: { findMany: jest.fn(async () => []) },
    sale: { findMany: jest.fn(async () => []) },
  };
  const refuser = new StockConflictRefuser(
    prisma as never,
    {
      loadActiveSales: jest.fn(async () => []),
      calculateDiscounts: jest.fn(async () => new Map()),
    } as never,
  );
  return { refuser, prisma, tickets, attempts, findParts };
}

const short = (requested: number, available: number): UnavailableLine => ({
  partId: ORIGIN.id,
  title: ORIGIN.title,
  reason: 'insufficient_stock',
  requestedQuantity: requested,
  availableQuantity: available,
});

const LINE = [{ id: 'line-1', partId: ORIGIN.id, quantity: 5 }];

async function refusal(ctx: ReturnType<typeof setup>, line = short(5, 2)) {
  const err = await ctx.refuser
    .refuse('user-1', LINE, [line])
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConflictException);
  return (err as ConflictException).getResponse() as Row;
}

beforeEach(() => {
  process.env.INVENTORY_RESERVATIONS_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.INVENTORY_RESERVATIONS_ENABLED;
});

describe('why a request cannot be met', () => {
  it('more than the supplier has is a source shortage', () => {
    expect(shortageCause(5, 2, 0)).toBe('SOURCE_STOCK');
  });
  it('units other orders hold are not a source shortage', () => {
    expect(shortageCause(2, 2, 0)).toBe('MATOR_RESERVATIONS');
  });
  it('a unit Mator already sold is gone, whatever the file still says', () => {
    expect(shortageCause(2, 2, 1)).toBe('SOURCE_STOCK');
  });
});

describe('a refused checkout', () => {
  it('answers 409 PART_UNAVAILABLE with the quantities and the cause', async () => {
    const res = await refusal(setup());
    expect(res.code).toBe('PART_UNAVAILABLE');
    expect(res.details.lines[0]).toMatchObject({
      part_id: ORIGIN.id,
      requested_quantity: 5,
      available_quantity: 2,
      cause: 'source_stock',
    });
  });

  it('offers another seller with enough, at its real price, and does not call dealers', async () => {
    const ctx = setup([offer()]);
    const line = (await refusal(ctx)).details.lines[0];
    expect(line.alternatives[0]).toEqual({
      part_id: 'other',
      title: 'Filter (other)',
      seller_name: 'Other Dealer',
      price_uzs: 1500,
      available_quantity: 10,
      covers_requested: true,
    });
    expect(line.sourcing_requested).toBe(false);
    expect(ctx.tickets).toHaveLength(0);
  });

  it('says plainly when another seller only has part of it, and still asks the dealers', async () => {
    const ctx = setup([offer({ stockQty: 3 })]);
    const line = (await refusal(ctx)).details.lines[0];
    expect(line.alternatives[0]).toMatchObject({
      available_quantity: 3,
      covers_requested: false,
    });
    expect(line.sourcing_requested).toBe(true);
    expect(ctx.tickets).toHaveLength(1);
  });

  it('a seller with all of it promised is not offered', async () => {
    const ctx = setup([offer({ stockQty: 3, reservedQty: 3 })]);
    expect((await refusal(ctx)).details.lines[0].alternatives).toEqual([]);
  });

  it('asks only for what the catalog would list', async () => {
    const ctx = setup();
    await refusal(ctx);
    const where = ctx.findParts.mock.calls[1][0].where as Row;
    expect(where).toMatchObject({
      id: { not: ORIGIN.id },
      sellerId: { not: ORIGIN.sellerId },
      inStock: true,
      seller: { status: { not: 'SUSPENDED' } },
      images: { isEmpty: false },
    });
  });

  it('with no seller at all, opens one ticket in the existing outbox', async () => {
    const ctx = setup();
    await refusal(ctx);
    expect(ctx.tickets).toHaveLength(1);
    expect(ctx.tickets[0]).toMatchObject({
      userId: 'user-1',
      partName: ORIGIN.title,
      requestId: 'req',
      staffNotifyStatus: 'PENDING',
      extractedData: {
        stock_shortage: {
          part_id: ORIGIN.id,
          part_numbers: ['GM1', 'OEM1'],
          requested_qty: 5,
          seller: "Driver's Village",
          reported_qty: 2,
          reserved_qty: 0,
        },
      },
    });
  });

  it('the same line retried counts again and opens no second ticket', async () => {
    const ctx = setup();
    await refusal(ctx);
    const again = (await refusal(ctx)).details.lines[0];
    expect(ctx.tickets).toHaveLength(1);
    expect(again.sourcing_requested).toBe(true);
    expect([...ctx.attempts.values()][0].attempts).toBe(2);
  });

  it('units merely held by other orders are not reported as missing', async () => {
    const ctx = setup();
    const line = (await refusal(ctx, short(2, 0))).details.lines[0];
    expect(line.cause).toBe('reserved');
    expect(line.sourcing_requested).toBe(false);
    expect(ctx.tickets).toHaveLength(0);
    expect([...ctx.attempts.values()][0].cause).toBe('MATOR_RESERVATIONS');
  });

  it('a bookkeeping failure never changes the answer to the buyer', async () => {
    const ctx = setup();
    ctx.prisma.$transaction.mockRejectedValueOnce(new Error('db down'));
    expect((await refusal(ctx)).code).toBe('PART_UNAVAILABLE');
  });
});
