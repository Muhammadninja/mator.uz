/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- the Prisma harness is untyped by design */
// The reservation ledger against an in-memory store: what each lifecycle event and each
// 1C file does to the numbers. Row locks need PostgreSQL, see
// test/integration/inventory-reservations.int-spec.ts.
import {
  InventoryReservationStatus as S,
  OrderStatus,
  PaymentType,
} from '@prisma/client';
import {
  findUnavailableParts,
  exceedsCountedStock,
} from '../order-availability';
import { availableUnits, isBuyerInStock } from './inventory-availability';
import {
  applyOrderStatus,
  extendHold,
  reconcileFromSource,
  reconcileRow,
  reserveOrderLines,
  restockRow,
} from './inventory-reservation.store';

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
      if ('in' in want) return (want.in as unknown[]).includes(row[key]);
      if ('not' in want) return row[key] !== want.not;
    }
    return row[key] === want;
  });
}

const T0 = new Date('2026-11-01T10:00:00Z');
const after = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function world(stockQty: number, partId = 'part_stock_7') {
  const reservations: Row[] = [];
  const parts: Row[] = [
    {
      id: partId,
      stockQty,
      reservedQty: 0,
      inStock: stockQty > 0,
      sellerId: 'drivers-village',
      oemNumbers: ['OEM1'],
      gmNumbers: ['GM1'],
      priceUzs: 1000,
      categoryId: 'c1',
      seller: { name: "Driver's Village", status: 'ACTIVE' },
    },
  ];
  const collections = new Set<string>();
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn(
      async (_s: TemplateStringsArray, delta: number, id: string) => {
        const part = parts.find((p) => p.id === id)!;
        part.reservedQty = Math.max(part.reservedQty + delta, 0);
        return 1;
      },
    ),
    catalogPart: {
      findMany: jest.fn(async ({ where }: Row) =>
        parts.filter((p) => where.id.in.includes(p.id)),
      ),
    },
    partCategory: { findMany: jest.fn().mockResolvedValue([]) },
    stock: {
      findMany: jest.fn(async ({ where }: Row) =>
        where.id.in.map((id: number) => ({ id })),
      ),
    },
    offlineCollection: {
      findUnique: jest.fn(async ({ where }: Row) =>
        collections.has(where.orderId) ? { id: 'c' } : null,
      ),
    },
    inventoryReservation: {
      createMany: jest.fn(async ({ data }: Row) => {
        for (const d of data) {
          if (reservations.some((r) => r.orderItemRef === d.orderItemRef)) {
            throw new Error('unique violation');
          }
          reservations.push({
            reconciledQty: 0,
            restockedQty: 0,
            status: S.HELD,
            allocatedAt: null,
            fulfilledAt: null,
            returnPendingAt: null,
            statusChangedAt: T0,
            reconciliationNote: null,
            ...d,
          });
        }
      }),
      findMany: jest.fn(async ({ where }: Row) =>
        reservations
          .filter((r) => matches(r, where))
          .map((r) => ({ ...r }))
          .sort(
            (a, b) =>
              (a.allocatedAt?.getTime() ?? 0) - (b.allocatedAt?.getTime() ?? 0),
          ),
      ),
      updateMany: jest.fn(async ({ where, data }: Row) => {
        const hit = reservations.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
  };
  const part = parts[0];
  let n = 0;
  const reserve = (
    quantity: number,
    orderId = `o${++n}`,
    paymentType: PaymentType = PaymentType.PAYME,
  ) =>
    reserveOrderLines(tx, {
      id: orderId,
      expiresAt: after(30),
      paymentType,
      items: [{ id: `${orderId}-line`, partId, title: 'Filter', quantity }],
    }).then(() => orderId);
  const refused = async (quantity: number) =>
    (
      await findUnavailableParts(tx, [{ partId, title: 'Filter', quantity }])
    )[0];
  const report = (newQty: number, at: Date | null) => {
    const previous = part.stockQty;
    part.stockQty = newQty;
    part.inStock = newQty > 0;
    return reconcileFromSource(
      tx,
      partId,
      previous,
      newQty,
      at ? { at, ref: 'file' } : null,
      at ?? T0,
    );
  };
  const sell = async (quantity: number, at = T0) => {
    const id = await reserve(quantity);
    jest.useFakeTimers({ now: at });
    await applyOrderStatus(tx, id, OrderStatus.PAID);
    jest.useRealTimers();
    return id;
  };
  return {
    tx,
    part,
    partId,
    reservations,
    collections,
    reserve,
    refused,
    report,
    sell,
  };
}

beforeEach(() => {
  process.env.INVENTORY_RESERVATIONS_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.INVENTORY_RESERVATIONS_ENABLED;
  jest.useRealTimers();
});

describe('what can be reserved', () => {
  it('10 on hand, nothing promised: 3 can be reserved and the buyer sees 7 at once', async () => {
    const w = world(10);
    expect(await w.refused(3)).toBeUndefined();
    await w.reserve(3);
    expect(w.part.reservedQty).toBe(3);
    expect(availableUnits(w.part as never)).toBe(7);
  });

  it('10 on hand, 8 promised: 3 more is refused, reporting 2', async () => {
    const w = world(10);
    await w.reserve(8);
    expect(await w.refused(3)).toMatchObject({
      reason: 'insufficient_stock',
      availableQuantity: 2,
      requestedQuantity: 3,
    });
  });

  it('10 on hand, 4 promised: 6 passes and 7 does not', async () => {
    const w = world(10);
    await w.reserve(4);
    expect(await w.refused(6)).toBeUndefined();
    expect(await w.refused(7)).toMatchObject({ availableQuantity: 6 });
  });

  it('zero stock is refused and takes no reservation', async () => {
    const w = world(0);
    w.part.inStock = false;
    expect(await w.refused(1)).toMatchObject({
      reason: 'out_of_stock',
      availableQuantity: 0,
    });
  });

  it('a Telegram listing has no count: never limited, never reserved', async () => {
    const w = world(0);
    w.part.inStock = true;
    w.part.sellerId = 'seller_42';
    expect(await w.refused(50)).toBeUndefined();
    await w.reserve(50);
    expect(w.reservations).toHaveLength(0);
    expect(w.part.reservedQty).toBe(0);
  });

  it('a part with every unit promised reads as out of stock to a buyer', async () => {
    const w = world(2);
    await w.reserve(2);
    expect(isBuyerInStock(w.part as never)).toBe(false);
  });

  it('never below zero', async () => {
    const w = world(5);
    await w.reserve(4);
    await w.report(1, after(5));
    expect(availableUnits(w.part as never)).toBe(0);
  });

  it('feature off: reservedQty is ignored, so behaviour is what it was', async () => {
    const w = world(10);
    w.part.reservedQty = 9;
    delete process.env.INVENTORY_RESERVATIONS_ENABLED;
    expect(await w.refused(10)).toBeUndefined();
    expect(exceedsCountedStock(10, 11)).toBe(true);
    await applyOrderStatus(w.tx, 'o1', OrderStatus.CANCELLED);
    expect(w.tx.inventoryReservation.findMany).not.toHaveBeenCalled();
  });

  it('a second attempt for the same order line cannot reserve twice', async () => {
    const w = world(10);
    await w.reserve(1, 'same');
    await expect(w.reserve(1, 'same')).rejects.toThrow('unique');
    expect(w.reservations).toHaveLength(1);
  });
});

describe('order lifecycle', () => {
  it('an unpaid online order that expires gives its stock back exactly once', async () => {
    const w = world(10);
    const id = await w.reserve(3);
    await applyOrderStatus(w.tx, id, OrderStatus.EXPIRED);
    await applyOrderStatus(w.tx, id, OrderStatus.EXPIRED);
    expect(w.reservations[0].status).toBe(S.RELEASED);
    expect(w.part.reservedQty).toBe(0);
  });

  it('a paid order is allocated, and a repeated Perform allocates nothing more', async () => {
    const w = world(10);
    const id = await w.reserve(3);
    await applyOrderStatus(w.tx, id, OrderStatus.PAID);
    const first = w.reservations[0].allocatedAt;
    await applyOrderStatus(w.tx, id, OrderStatus.PAID);
    expect(w.reservations[0]).toMatchObject({
      status: S.ALLOCATED,
      allocatedAt: first,
    });
    expect(w.part.reservedQty).toBe(3);
  });

  it('a cancelled provider payment keeps the hold and moves its window', async () => {
    const w = world(10);
    const id = await w.reserve(3);
    await extendHold(w.tx, id, after(90));
    expect(w.reservations[0]).toMatchObject({
      status: S.HELD,
      expiresAt: after(90),
    });
  });

  it('a cash order is held with no expiry', async () => {
    const w = world(10);
    await w.reserve(2, 'cash', PaymentType.CASH);
    expect(w.reservations[0]).toMatchObject({
      status: S.HELD,
      expiresAt: null,
    });
  });

  it('recording a collection changes nothing about the reservation', async () => {
    const w = world(10);
    await w.reserve(2, 'cash', PaymentType.CASH);
    w.collections.add('cash');
    await applyOrderStatus(w.tx, 'cash', OrderStatus.PROCESSING);
    expect(w.reservations[0].status).toBe(S.HELD);
    expect(w.part.reservedQty).toBe(2);
  });

  it('cancelling an uncollected cash order restores availability', async () => {
    const w = world(10);
    await w.reserve(2, 'cash', PaymentType.CASH);
    await applyOrderStatus(w.tx, 'cash', OrderStatus.CANCELLED);
    expect(w.reservations[0].status).toBe(S.RELEASED);
    expect(availableUnits(w.part as never)).toBe(10);
  });

  it('a collected order cancelled by an operator stays deducted, awaiting a restock', async () => {
    const w = world(10);
    await w.reserve(2, 'cash', PaymentType.CASH);
    w.collections.add('cash');
    await applyOrderStatus(w.tx, 'cash', OrderStatus.CANCELLED);
    expect(w.reservations[0].status).toBe(S.ALLOCATED);
    expect(w.reservations[0].returnPendingAt).toBeInstanceOf(Date);
    expect(w.part.reservedQty).toBe(2);
  });

  it('a delivered order stays deducted until the source shows it', async () => {
    const w = world(10);
    const id = await w.reserve(2);
    await applyOrderStatus(w.tx, id, OrderStatus.PAID);
    await applyOrderStatus(w.tx, id, OrderStatus.SHIPPED);
    await applyOrderStatus(w.tx, id, OrderStatus.DELIVERED);
    expect(w.reservations[0].status).toBe(S.ALLOCATED);
    expect(availableUnits(w.part as never)).toBe(8);
  });

  it('a paid order cancelled before shipping gives the stock back', async () => {
    const w = world(10);
    const id = await w.reserve(2);
    await applyOrderStatus(w.tx, id, OrderStatus.PAID);
    await applyOrderStatus(w.tx, id, OrderStatus.REFUNDED);
    expect(w.reservations[0].status).toBe(S.RELEASED);
    expect(w.part.reservedQty).toBe(0);
  });

  it('a shipped order that is cancelled does not put goods back by itself', async () => {
    const w = world(10);
    const id = await w.reserve(2);
    await applyOrderStatus(w.tx, id, OrderStatus.SHIPPED);
    await applyOrderStatus(w.tx, id, OrderStatus.CANCELLED);
    expect(w.reservations[0].status).toBe(S.ALLOCATED);
    expect(w.part.reservedQty).toBe(2);
  });

  it('only the units explicitly restocked come back', async () => {
    const w = world(10);
    const id = await w.reserve(3);
    await applyOrderStatus(w.tx, id, OrderStatus.DELIVERED);
    await restockRow(w.tx, { ...w.reservations[0] } as never, 1);
    expect(w.reservations[0]).toMatchObject({
      status: S.ALLOCATED,
      restockedQty: 1,
    });
    expect(availableUnits(w.part as never)).toBe(8);
  });
});

describe('1C files against Mator sales', () => {
  it('a newer file with the sale in it settles the sale exactly once', async () => {
    const w = world(10);
    await w.sell(3);
    expect(availableUnits(w.part as never)).toBe(7);
    await w.report(7, after(60));
    expect(w.reservations[0]).toMatchObject({
      status: S.RECONCILED,
      reconciledQty: 3,
      reconciliationSource: 'SOURCE_IMPORT',
    });
    expect(availableUnits(w.part as never)).toBe(7);
  });

  it('the same file again changes nothing, so stock is not taken twice', async () => {
    const w = world(10);
    await w.sell(3);
    await w.report(7, after(60));
    await w.report(7, after(60));
    expect(w.part.reservedQty).toBe(0);
    expect(availableUnits(w.part as never)).toBe(7);
  });

  it('a retried projection of the same count cannot deduct twice', async () => {
    const w = world(10);
    await w.sell(3);
    await reconcileFromSource(w.tx, w.partId, 10, 7, {
      at: after(60),
      ref: 'f',
    });
    await reconcileFromSource(w.tx, w.partId, 7, 7, {
      at: after(60),
      ref: 'f',
    });
    expect(w.reservations[0].reconciledQty).toBe(3);
  });

  it('a file that fell short settles part of the sale and keeps the rest deducted', async () => {
    const w = world(10);
    await w.sell(3);
    await w.report(9, after(60));
    expect(w.reservations[0]).toMatchObject({
      status: S.ALLOCATED,
      reconciledQty: 1,
    });
    expect(availableUnits(w.part as never)).toBe(7);
    await w.report(7, after(120));
    expect(w.reservations[0]).toMatchObject({
      status: S.RECONCILED,
      reconciledQty: 3,
    });
    expect(availableUnits(w.part as never)).toBe(7);
  });

  it('a rise cannot prove a sale: the deduction stands and the row says why', async () => {
    const w = world(10);
    await w.sell(3);
    await w.report(15, after(60));
    expect(w.reservations[0].status).toBe(S.ALLOCATED);
    expect(w.reservations[0].reconciliationNote).toContain('raised the count');
    expect(availableUnits(w.part as never)).toBe(12);
  });

  it('a file sent before the sale cannot settle it, even with a lower count', async () => {
    const w = world(10);
    await w.sell(3, after(30));
    await w.report(7, after(10));
    expect(w.reservations[0].status).toBe(S.ALLOCATED);
    expect(w.reservations[0].reconciliationNote).toContain('before this sale');
    expect(availableUnits(w.part as never)).toBe(4);
  });

  it('a file of unknown date settles nothing', async () => {
    const w = world(10);
    await w.sell(3);
    await w.report(7, null);
    expect(w.reservations[0].status).toBe(S.ALLOCATED);
    expect(w.reservations[0].reconciliationNote).toContain('unknown date');
  });

  it('a stale higher count cannot restore a sold unit', async () => {
    const w = world(5);
    await w.sell(5);
    await w.report(5, after(60));
    expect(availableUnits(w.part as never)).toBe(0);
    await w.report(8, after(90));
    expect(w.reservations[0].status).toBe(S.ALLOCATED);
    expect(availableUnits(w.part as never)).toBe(3);
  });

  it('settles oldest first, and held units are never touched', async () => {
    const w = world(10);
    await w.sell(1, T0);
    await w.sell(2, after(1));
    await w.reserve(4);
    await w.report(8, after(60));
    const [a, b, held] = w.reservations;
    expect(a.status).toBe(S.RECONCILED);
    expect(b).toMatchObject({ status: S.ALLOCATED, reconciledQty: 1 });
    expect(held.status).toBe(S.HELD);
    expect(w.part.reservedQty).toBe(5);
  });

  it('never raises availability, whatever the count does', async () => {
    for (const next of [0, 1, 4, 7, 9, 10, 25]) {
      const w = world(10);
      await w.sell(3);
      const before = availableUnits(w.part as never);
      await w.report(next, after(60));
      expect(availableUnits(w.part as never)).toBeLessThanOrEqual(
        before + Math.max(0, next - 10),
      );
    }
  });

  it('a new count while orders are held leaves those holds intact', async () => {
    const w = world(10);
    await w.reserve(4);
    await w.report(6, after(60));
    expect(w.reservations[0].status).toBe(S.HELD);
    expect(availableUnits(w.part as never)).toBe(2);
    await w.report(20, after(90));
    expect(availableUnits(w.part as never)).toBe(16);
  });

  it('an operator can settle what no file could, keeping the record of who did', async () => {
    const w = world(10);
    await w.sell(3);
    await reconcileRow(
      w.tx,
      { ...w.reservations[0] } as never,
      'Operator A: checked 1C',
    );
    expect(w.reservations[0]).toMatchObject({
      status: S.RECONCILED,
      reconciliationSource: 'OPERATOR',
      reconciliationRef: 'Operator A: checked 1C',
    });
  });
});
