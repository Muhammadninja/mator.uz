/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- the Prisma harness is untyped by design */
// ORD-001. The real OrdersService over one in-memory cart, with $transaction run
// strictly one at a time, as the FOR UPDATE on the cart row makes them in PostgreSQL.
// That shows what the second checkout does once it gets the lock; that PostgreSQL
// really serializes them is proved by test/integration/p1-concurrency.int-spec.ts.
import { ConflictException } from '@nestjs/common';
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
const PICKUP = { cart_snapshot: { delivery_method: 'pickup' } } as never;

function world(items = [buildCartItem({ id: 'line_1', cartId: 'cart_1' })]) {
  const prisma: any = createPrismaMock();
  const state = {
    items: items.map((i) => ({ ...i })) as any[],
    promoCode: null as string | null,
    orders: [] as unknown[],
    prices: { part_belt: 185000 } as Record<string, number>,
    inStock: true,
    onLocked: undefined as undefined | (() => void),
  };
  prisma.cart.findUnique.mockImplementation(async () =>
    buildCart({
      id: 'cart_1',
      userId: USER,
      promoCode: state.promoCode,
      items: state.items.map((i) => ({ ...i })),
    }),
  );
  prisma.cart.update.mockImplementation(async ({ data }: any) => {
    state.promoCode = data.promoCode ?? null;
    return {};
  });
  prisma.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) => {
    if (sql[0].includes('cart_items')) state.onLocked?.();
    return [];
  });
  prisma.cartItem.updateMany.mockResolvedValue({ count: 1 });
  prisma.cartItem.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = state.items.length;
    state.items = state.items.filter((i) => !where.id.in.includes(i.id));
    return { count: before - state.items.length };
  });
  prisma.catalogPart.findMany.mockImplementation(async ({ where }: any) =>
    where.id.in.map((id: string) => ({
      id,
      inStock: state.inStock,
      priceUzs: state.prices[id],
      seller: { status: 'ACTIVE' },
      categoryId: 'cat_1',
      sellerId: 'seller_1',
    })),
  );
  prisma.sale.findMany.mockResolvedValue([]);
  prisma.seller.findMany.mockResolvedValue([]);
  prisma.order.create.mockImplementation(async ({ data }: any) => {
    const order = buildOrder({ id: `ord_${state.orders.length + 1}` });
    state.orders.push(data);
    return order;
  });
  let queue: Promise<unknown> = Promise.resolve();
  prisma.$transaction.mockImplementation((work: any) => {
    const run = queue.then(() => work(prisma));
    queue = run.catch(() => undefined);
    return run;
  });
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
  return { prisma, state, orders };
}

const codeOf = (result: PromiseSettledResult<unknown>) =>
  ((result as PromiseRejectedResult).reason as ConflictException).getResponse();

describe('createFromCart under concurrency (ORD-001)', () => {
  it('two simultaneous checkouts create exactly one order', async () => {
    const { state, orders } = world();

    const results = await Promise.allSettled([
      orders.createFromCart(USER, PICKUP),
      orders.createFromCart(USER, PICKUP),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(state.orders).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected')!;
    expect(codeOf(refused)).toMatchObject({ code: 'CART_CHANGED' });
  });

  it('reads the cart under its lock, before anything is written', async () => {
    const { prisma, orders } = world();
    await orders.createFromCart(USER, PICKUP);

    const statements = prisma.$queryRaw.mock.calls.map(
      ([sql]: [TemplateStringsArray]) => sql.join('?'),
    );
    expect(statements[0]).toContain('FROM carts');
    expect(statements[0]).toContain('FOR UPDATE');
    expect(statements[1]).toContain('FROM cart_items');
    expect(statements[1]).toContain('FOR UPDATE');
  });

  it('refuses a cart that gained a line after it was priced; the line stays', async () => {
    const { state, orders } = world();
    state.onLocked = () => {
      state.items.push(buildCartItem({ id: 'line_2', cartId: 'cart_1' }));
      state.onLocked = undefined;
    };

    await expect(orders.createFromCart(USER, PICKUP)).rejects.toMatchObject({
      response: { code: 'CART_CHANGED' },
    });
    expect(state.orders).toHaveLength(0);
    expect(state.items.map((i) => i.id)).toEqual(['line_1', 'line_2']);
  });

  it('refuses a cart whose quantity changed after it was priced', async () => {
    const { state, orders } = world();
    state.onLocked = () => {
      state.items[0].quantity = 5;
      state.onLocked = undefined;
    };
    await expect(orders.createFromCart(USER, PICKUP)).rejects.toMatchObject({
      response: { code: 'CART_CHANGED' },
    });
    expect(state.orders).toHaveLength(0);
  });

  it('deletes only the ordered lines, by id', async () => {
    const { prisma, orders } = world();
    await orders.createFromCart(USER, PICKUP);
    expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { cartId: 'cart_1', id: { in: ['line_1'] } },
    });
  });

  it('rolls back when the delete does not match the ordered lines', async () => {
    const { prisma, orders } = world();
    prisma.cartItem.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(orders.createFromCart(USER, PICKUP)).rejects.toMatchObject({
      response: { code: 'CART_CHANGED' },
    });
  });

  it('keeps the ORDER_TOTAL_CHANGED refusal for a price that moved under the lock', async () => {
    const { state, orders } = world();
    state.onLocked = () => {
      state.prices.part_belt = 200000;
    };
    await expect(orders.createFromCart(USER, PICKUP)).rejects.toMatchObject({
      response: { code: 'ORDER_TOTAL_CHANGED' },
    });
    expect(state.orders).toHaveLength(0);
  });

  it('re-checks availability under the lock', async () => {
    const { state, orders } = world();
    state.onLocked = () => {
      state.inStock = false;
    };
    await expect(orders.createFromCart(USER, PICKUP)).rejects.toMatchObject({
      response: { code: 'PART_UNAVAILABLE' },
    });
    expect(state.orders).toHaveLength(0);
  });

  it('still places an ordinary order and empties the cart', async () => {
    const { state, orders } = world();
    await expect(orders.createFromCart(USER, PICKUP)).resolves.toBeDefined();
    expect(state.orders).toHaveLength(1);
    expect(state.items).toHaveLength(0);
  });
});
