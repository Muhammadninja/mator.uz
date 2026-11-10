/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- the Prisma harness is untyped by design */
// Paying for an existing order: it is never blocked by its own units, always by other
// buyers', and a hold that ran out pays for nothing. Plus the zero of a Driver's
// Village count, which is always zero.
import { findUnavailableParts } from '../order-availability';
import { findUnavailableForPayment } from './payment-availability';

const NOW = new Date('2026-11-10T12:00:00Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

type Res = {
  id: string;
  orderId: string;
  status: 'HELD' | 'ALLOCATED';
  quantity: number;
  createdAt: Date;
  expiresAt?: Date | null;
};

function db(opts: {
  stockQty: number;
  sellerId?: string;
  inStock?: boolean;
  items?: Record<string, number>;
  reservations?: Res[];
  activeTx?: boolean;
}) {
  const reservations = (opts.reservations ?? []).map((r) => ({
    partId: 'p1',
    reconciledQty: 0,
    restockedQty: 0,
    expiresAt: null,
    ...r,
  }));
  const reserved = reservations.reduce((s, r) => s + r.quantity, 0);
  return {
    catalogPart: {
      findMany: jest.fn(async () => [
        {
          id: 'p1',
          inStock: opts.inStock ?? opts.stockQty > 0,
          stockQty: opts.stockQty,
          reservedQty: reserved,
          priceUzs: 1000,
          categoryId: 'c1',
          sellerId: opts.sellerId ?? 'drivers-village',
          seller: { status: 'ACTIVE' },
        },
      ]),
    },
    partCategory: { findMany: jest.fn(async () => []) },
    orderItem: {
      findMany: jest.fn(async ({ where }: any) => [
        {
          partId: 'p1',
          title: 'Filter',
          quantity: opts.items?.[where.orderId] ?? 1,
        },
      ]),
    },
    inventoryReservation: {
      findMany: jest.fn(async () => reservations.map((r) => ({ ...r }))),
    },
    payment: {
      findFirst: jest.fn(async () => (opts.activeTx ? { id: 'pay' } : null)),
    },
  } as any;
}

const pay = (d: any, orderId: string) =>
  findUnavailableForPayment(d, orderId, NOW);

beforeEach(() => {
  process.env.INVENTORY_RESERVATIONS_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.INVENTORY_RESERVATIONS_ENABLED;
});

describe('paying for an order with reservations on', () => {
  it('an order holding every unit is not blocked by its own hold', async () => {
    const d = db({
      stockQty: 3,
      items: { A: 3 },
      reservations: [
        {
          id: 'r1',
          orderId: 'A',
          status: 'HELD',
          quantity: 3,
          createdAt: at(-5),
          expiresAt: at(20),
        },
      ],
    });
    expect(await pay(d, 'A')).toEqual([]);
  });

  it("other buyers' holds still count: only this order's own units are left out", async () => {
    const d = db({
      stockQty: 2,
      items: { B: 1 },
      reservations: [
        {
          id: 'r1',
          orderId: 'A',
          status: 'HELD',
          quantity: 1,
          createdAt: at(-10),
          expiresAt: at(20),
        },
        {
          id: 'r2',
          orderId: 'B',
          status: 'HELD',
          quantity: 1,
          createdAt: at(-5),
          expiresAt: at(20),
        },
      ],
    });
    expect(await pay(d, 'B')).toEqual([]);
    // The supplier's count fell to 1: the earlier hold keeps its unit, the later one cannot pay.
    const shrunk = db({
      stockQty: 1,
      items: { A: 1, B: 1 },
      reservations: [
        {
          id: 'r1',
          orderId: 'A',
          status: 'HELD',
          quantity: 1,
          createdAt: at(-10),
          expiresAt: at(20),
        },
        {
          id: 'r2',
          orderId: 'B',
          status: 'HELD',
          quantity: 1,
          createdAt: at(-5),
          expiresAt: at(20),
        },
      ],
    });
    expect(await pay(shrunk, 'A')).toEqual([]);
    expect(await pay(shrunk, 'B')).toEqual([
      expect.objectContaining({
        reason: 'insufficient_stock',
        availableQuantity: 0,
        requestedQuantity: 1,
      }),
    ]);
  });

  it('a sale already paid comes before any hold, however new', async () => {
    const d = db({
      stockQty: 1,
      items: { A: 1 },
      reservations: [
        {
          id: 'r1',
          orderId: 'A',
          status: 'HELD',
          quantity: 1,
          createdAt: at(-10),
          expiresAt: at(20),
        },
        {
          id: 'r2',
          orderId: 'C',
          status: 'ALLOCATED',
          quantity: 1,
          createdAt: at(-1),
        },
      ],
    });
    expect(await pay(d, 'A')).toEqual([
      expect.objectContaining({ reason: 'insufficient_stock' }),
    ]);
  });

  it('an order with no reservation of its own is held against every other one', async () => {
    const d = db({
      stockQty: 2,
      items: { LEGACY: 1 },
      reservations: [
        {
          id: 'r1',
          orderId: 'A',
          status: 'HELD',
          quantity: 2,
          createdAt: at(-10),
          expiresAt: at(20),
        },
      ],
    });
    expect(await pay(d, 'LEGACY')).toEqual([
      expect.objectContaining({
        reason: 'insufficient_stock',
        availableQuantity: 0,
      }),
    ]);
  });

  it('a hold whose payment window passed cannot be paid for, even with stock on hand', async () => {
    const d = db({
      stockQty: 10,
      items: { A: 1 },
      reservations: [
        {
          id: 'r1',
          orderId: 'A',
          status: 'HELD',
          quantity: 1,
          createdAt: at(-40),
          expiresAt: at(-1),
        },
      ],
    });
    expect(await pay(d, 'A')).toEqual([
      expect.objectContaining({ reason: 'reservation_expired' }),
    ]);
  });

  it('a provider transaction in progress keeps the hold alive, as Payme requires', async () => {
    const d = db({
      stockQty: 10,
      items: { A: 1 },
      activeTx: true,
      reservations: [
        {
          id: 'r1',
          orderId: 'A',
          status: 'HELD',
          quantity: 1,
          createdAt: at(-40),
          expiresAt: at(-1),
        },
      ],
    });
    expect(await pay(d, 'A')).toEqual([]);
  });

  it('a cash or terminal hold has no window to run out', async () => {
    const d = db({
      stockQty: 1,
      items: { A: 1 },
      reservations: [
        {
          id: 'r1',
          orderId: 'A',
          status: 'HELD',
          quantity: 1,
          createdAt: at(-9_000),
          expiresAt: null,
        },
      ],
    });
    expect(await pay(d, 'A')).toEqual([]);
  });
});

describe('paying with reservations off', () => {
  it('is the check it replaces: the count alone, reservations unread', async () => {
    delete process.env.INVENTORY_RESERVATIONS_ENABLED;
    const d = db({
      stockQty: 1,
      items: { A: 1 },
      reservations: [
        {
          id: 'r',
          orderId: 'X',
          status: 'HELD',
          quantity: 1,
          createdAt: at(-1),
        },
      ],
    });
    expect(await pay(d, 'A')).toEqual([]);
    expect(d.inventoryReservation.findMany).not.toHaveBeenCalled();
  });
});

describe("a Driver's Village zero", () => {
  for (const flag of ['on', 'off']) {
    it(`refuses a new order even when inStock disagrees (reservations ${flag})`, async () => {
      if (flag === 'off') delete process.env.INVENTORY_RESERVATIONS_ENABLED;
      const d = db({ stockQty: 0, inStock: true });
      expect(
        await findUnavailableParts(d, [
          { partId: 'p1', title: 'F', quantity: 1 },
        ]),
      ).toEqual([
        expect.objectContaining({
          reason: 'out_of_stock',
          availableQuantity: 0,
        }),
      ]);
    });
  }

  it('refuses through the ordinary flag too', async () => {
    const d = db({ stockQty: 0, inStock: false });
    expect(
      await findUnavailableParts(d, [
        { partId: 'p1', title: 'F', quantity: 1 },
      ]),
    ).toEqual([expect.objectContaining({ reason: 'out_of_stock' })]);
  });

  it('a Telegram listing with no count keeps the old rule: sellable, any quantity', async () => {
    for (const flag of [true, false]) {
      if (!flag) delete process.env.INVENTORY_RESERVATIONS_ENABLED;
      const d = db({ stockQty: 0, inStock: true, sellerId: 'seller_42' });
      expect(
        await findUnavailableParts(d, [
          { partId: 'p1', title: 'F', quantity: 50 },
        ]),
      ).toEqual([]);
    }
  });

  it('a Telegram listing that is switched off is still refused', async () => {
    const d = db({ stockQty: 0, inStock: false, sellerId: 'seller_42' });
    expect(
      await findUnavailableParts(d, [
        { partId: 'p1', title: 'F', quantity: 1 },
      ]),
    ).toEqual([expect.objectContaining({ reason: 'out_of_stock' })]);
  });

  it('cannot be paid for, if one was ordered before the count dropped', async () => {
    const d = db({
      stockQty: 0,
      inStock: true,
      items: { A: 1 },
      reservations: [
        {
          id: 'r1',
          orderId: 'A',
          status: 'HELD',
          quantity: 1,
          createdAt: at(-5),
          expiresAt: at(20),
        },
      ],
    });
    expect(await pay(d, 'A')).toEqual([
      expect.objectContaining({ reason: 'out_of_stock' }),
    ]);
  });
});
