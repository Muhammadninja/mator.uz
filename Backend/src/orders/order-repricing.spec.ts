/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// BUG-001: an order is charged the catalog's current price, never the snapshot the
// cart took when the item was added. The real CartService, OrdersService and
// DiscountService run over one stateful in-memory cart and catalog.
import { Prisma, SaleDiscountType, SaleScopeType } from '@prisma/client';
import { CartService } from '../cart/cart.service';
import { OrderStatusService } from './order-status.service';
import { OrdersService } from './orders.service';
import { DiscountService } from '../sales/discount.service';
import {
  buildCart,
  buildCartItem,
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeDeliveryQuotes,
  fakeNotifications,
  fakeRealtime,
} from '../../test/utils/harness';

const USER = 'usr_1';
const PICKUP = { cart_snapshot: { delivery_method: 'pickup' } };

function world(lines: Record<string, unknown>[]) {
  const prisma: any = createPrismaMock();
  const state = {
    parts: new Map<string, number>(),
    services: new Map<string, number>(),
    offers: new Map<string, number>(),
    items: lines.map((l) => buildCartItem(l)),
    promoCode: null as string | null,
    inTransaction: false,
    writesDuringTransaction: 0,
  };
  const cart = async () =>
    buildCart({
      id: 'cart_1',
      userId: USER,
      promoCode: state.promoCode,
      items: state.items.map((i: any) => ({ ...i })),
    });
  prisma.cart.findUnique.mockImplementation(cart);
  prisma.cart.upsert.mockImplementation(cart);
  prisma.cartItem.updateMany.mockImplementation(
    async ({ where, data }: any) => {
      if (state.inTransaction) state.writesDuringTransaction++;
      const item: any = state.items.find((i: any) => i.id === where.id);
      if (item) item.priceUzsSnapshot = data.priceUzsSnapshot;
      return { count: item ? 1 : 0 };
    },
  );
  prisma.catalogPart.findMany.mockImplementation(async ({ where }: any) =>
    where.id.in.flatMap((id: string) =>
      state.parts.has(id)
        ? [
            {
              id,
              inStock: true,
              priceUzs: state.parts.get(id),
              seller: { status: 'ACTIVE' },
              categoryId: 'cat_1',
              sellerId: 'seller_1',
            },
          ]
        : [],
    ),
  );
  prisma.providerServiceOffering.findMany.mockImplementation(
    async ({ where }: any) =>
      where.id.in.flatMap((id: string) =>
        state.services.has(id)
          ? [
              {
                id,
                priceUzs: state.services.get(id),
                providerId: 'prov_1',
                provider: { isActive: true },
              },
            ]
          : [],
      ),
  );
  prisma.sourcingOffer.findMany.mockImplementation(async ({ where }: any) =>
    where.id.in.flatMap((id: string) =>
      state.offers.has(id)
        ? [
            {
              id,
              price: state.offers.get(id),
              status: 'ACCEPTED',
              sellerTgId: '1',
              ticket: { status: 'ACCEPTED' },
            },
          ]
        : [],
    ),
  );
  prisma.sale.findMany.mockResolvedValue([]);
  prisma.seller.findMany.mockResolvedValue([]);
  prisma.order.create.mockResolvedValue(buildOrder({ id: 'ord_1' }));
  const discounts = new DiscountService(prisma);
  const orders = new OrdersService(
    prisma,
    fakeConfig(),
    fakeNotifications(),
    fakeRealtime(),
    new OrderStatusService(prisma),
    discounts,
    { record: jest.fn() } as never,
    fakeDeliveryQuotes(),
  );
  const carts = new CartService(prisma, discounts);
  return { prisma, state, orders, carts };
}

const place = (orders: OrdersService, extra: object = {}) =>
  orders.createFromCart(USER, { ...PICKUP, ...extra } as never);

const sale = (
  value: number,
  type: SaleDiscountType = SaleDiscountType.PERCENT,
) => ({
  id: 'sale_1',
  title: 'Sale',
  discountType: type,
  discountValue: new Prisma.Decimal(value),
  scopeType: SaleScopeType.ALL_PRODUCTS,
  priority: 0,
  createdAt: new Date('2026-01-01'),
  targets: [],
});

describe('an order uses current prices (BUG-001)', () => {
  const partLine = {
    id: 'ci_1',
    partId: 'part_1',
    priceUzsSnapshot: 100_000,
    quantity: 2,
  };

  it.each([
    ['increase', 150_000],
    ['decrease', 60_000],
  ])(
    'price %s: 409 with the new figures, then the cart shows it',
    async (_, next) => {
      const { prisma, state, orders, carts } = world([partLine]);
      state.parts.set('part_1', next);

      await expect(place(orders)).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'ORDER_TOTAL_CHANGED',
          details: expect.objectContaining({ subtotal_uzs: next * 2 }),
        },
      });

      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(Number((state.items[0] as any).priceUzsSnapshot)).toBe(next);
      const shown = await carts.snapshot(USER);
      expect(shown.items[0].price_uzs).toBe(next);
      expect(shown.subtotal_uzs).toBe(next * 2);
    },
  );

  it('after the refusal, confirming the new total places the order at the new price', async () => {
    const { prisma, state, orders, carts } = world([partLine]);
    state.parts.set('part_1', 150_000);
    await place(orders).catch(() => undefined);
    const { total_uzs } = await carts.snapshot(USER);

    await place(orders, { confirmed_total_uzs: total_uzs });

    const data = prisma.order.create.mock.calls[0][0].data;
    expect(data.subtotalUzs).toBe(300_000);
    expect(data.items.create[0].priceUzs).toBe(150_000);
  });

  it('cannot be charged at a stale snapshot even by confirming the old total', async () => {
    const { prisma, state, orders } = world([partLine]);
    state.parts.set('part_1', 120_000);

    await expect(
      place(orders, { confirmed_total_uzs: 200_000 }),
    ).rejects.toMatchObject({ response: { code: 'ORDER_TOTAL_CHANGED' } });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('an unchanged price orders normally and rewrites nothing', async () => {
    const { prisma, state, orders } = world([partLine]);
    state.parts.set('part_1', 100_000);

    await place(orders);

    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(prisma.cartItem.updateMany).not.toHaveBeenCalled();
  });

  it('applies an active sale to the current price, not the old one', async () => {
    const { prisma, state, orders, carts } = world([partLine]);
    state.parts.set('part_1', 200_000);
    prisma.sale.findMany.mockResolvedValue([sale(10)]);

    await expect(place(orders)).rejects.toMatchObject({
      response: {
        code: 'ORDER_TOTAL_CHANGED',
        details: expect.objectContaining({ subtotal_uzs: 360_000 }),
      },
    });

    const shown = await carts.snapshot(USER);
    expect(shown.items[0].price_uzs).toBe(180_000);
    expect(shown.items[0].original_price_uzs).toBe(200_000);
    await place(orders);
    expect(prisma.order.create.mock.calls[0][0].data.subtotalUzs).toBe(360_000);
  });

  it('a sale alone never marks the cart as changed', async () => {
    const { prisma, state, orders } = world([partLine]);
    state.parts.set('part_1', 100_000);
    prisma.sale.findMany.mockResolvedValue([sale(10)]);

    await place(orders);

    expect(prisma.order.create.mock.calls[0][0].data.subtotalUzs).toBe(180_000);
  });

  it('reprices a service line from its offering', async () => {
    const { prisma, state, orders } = world([
      {
        id: 'ci_s',
        partId: null,
        serviceId: 'svc_1',
        priceUzsSnapshot: 50_000,
      },
    ]);
    state.services.set('svc_1', 70_000);

    await expect(place(orders)).rejects.toMatchObject({
      response: { code: 'ORDER_TOTAL_CHANGED' },
    });
    expect(Number((state.items[0] as any).priceUzsSnapshot)).toBe(70_000);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('reprices an offer line from its offer', async () => {
    const { state, orders } = world([
      {
        id: 'ci_o',
        partId: null,
        offerId: 'soff_1',
        offer: { sellerTgId: '555' },
        priceUzsSnapshot: 80_000,
      },
    ]);
    state.offers.set('soff_1', 90_000);

    await expect(place(orders)).rejects.toMatchObject({
      response: { code: 'ORDER_TOTAL_CHANGED' },
    });
    expect(Number((state.items[0] as any).priceUzsSnapshot)).toBe(90_000);
  });

  it('refuses a service whose offering no longer exists', async () => {
    const { prisma, orders } = world([
      {
        id: 'ci_s',
        partId: null,
        serviceId: 'svc_gone',
        priceUzsSnapshot: 50_000,
      },
    ]);

    await expect(place(orders)).rejects.toMatchObject({
      response: { code: 'PART_UNAVAILABLE' },
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  describe('a price moving while the order is being written', () => {
    function moveInTransaction(w: ReturnType<typeof world>, move: () => void) {
      w.prisma.$transaction.mockImplementation(async (cb: any) => {
        move();
        w.state.inTransaction = true;
        try {
          return await cb(w.prisma);
        } finally {
          w.state.inTransaction = false;
        }
      });
    }

    it('is refused, and the refreshed snapshot survives the rollback', async () => {
      const w = world([partLine]);
      w.state.parts.set('part_1', 100_000);
      moveInTransaction(w, () => w.state.parts.set('part_1', 130_000));

      await expect(place(w.orders)).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'ORDER_TOTAL_CHANGED',
          details: expect.objectContaining({ subtotal_uzs: 260_000 }),
        },
      });

      expect(w.prisma.order.create).not.toHaveBeenCalled();
      expect(w.state.writesDuringTransaction).toBe(0);
      expect(Number((w.state.items[0] as any).priceUzsSnapshot)).toBe(130_000);
    });

    it('holds the part rows until the order commits', async () => {
      const w = world([partLine]);
      w.state.parts.set('part_1', 100_000);

      await place(w.orders);

      const lock = w.prisma.$queryRaw.mock.calls.findIndex(
        ([sql]: [TemplateStringsArray]) => sql.join('').includes('FOR SHARE'),
      );
      expect(lock).toBeGreaterThanOrEqual(0);
      const lockOrder = w.prisma.$queryRaw.mock.invocationCallOrder[lock];
      const writeOrder = w.prisma.order.create.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(writeOrder);
    });

    it('is refused when a sale changes the charged price meanwhile', async () => {
      const w = world([partLine]);
      w.state.parts.set('part_1', 100_000);
      moveInTransaction(w, () =>
        w.prisma.sale.findMany.mockResolvedValue([sale(25)]),
      );

      await expect(place(w.orders)).rejects.toMatchObject({
        response: {
          code: 'ORDER_TOTAL_CHANGED',
          details: expect.objectContaining({ subtotal_uzs: 150_000 }),
        },
      });
      expect(w.prisma.order.create).not.toHaveBeenCalled();
    });
  });

  it('never touches an existing order', async () => {
    const { prisma, state, orders } = world([partLine]);
    state.parts.set('part_1', 150_000);
    await place(orders).catch(() => undefined);

    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
  });

  describe('the cart keeps up by itself', () => {
    it('GET refreshes a stale snapshot', async () => {
      const { state, carts } = world([partLine]);
      state.parts.set('part_1', 140_000);

      const shown = await carts.snapshot(USER);

      expect(shown.items[0].price_uzs).toBe(140_000);
      expect(Number((state.items[0] as any).priceUzsSnapshot)).toBe(140_000);
    });

    it('adding the same part again takes the current price', async () => {
      const { prisma, state, carts } = world([partLine]);
      state.parts.set('part_1', 140_000);
      prisma.catalogPart.findFirst.mockResolvedValue({
        id: 'part_1',
        title: 'Belt',
        images: [],
        priceUzs: 140_000,
        inStock: true,
      });
      prisma.cartItem.update.mockResolvedValue({});

      await carts.addItem(USER, { part_id: 'part_1', quantity: 1 } as never);

      expect(prisma.cartItem.update).toHaveBeenCalledWith({
        where: { id: 'ci_1' },
        data: { quantity: 3, priceUzsSnapshot: 140_000 },
      });
    });

    it('a line whose part is gone keeps its snapshot, and the read still works', async () => {
      const { state, carts } = world([partLine]);

      const shown = await carts.snapshot(USER);

      expect(shown.items[0].price_uzs).toBe(100_000);
      expect(Number((state.items[0] as any).priceUzsSnapshot)).toBe(100_000);
    });
  });
});
