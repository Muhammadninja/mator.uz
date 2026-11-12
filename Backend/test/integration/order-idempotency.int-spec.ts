/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- results are read as the presented order, untyped by design */
// Checkout idempotency on real PostgreSQL: the unique index, the transaction that writes
// the order and its key together, and the cart's FOR UPDATE are what make one key one
// order, so these are proved here against the database itself, not a double.
// Runs only with TEST_DATABASE_URL pointing at a local *_test / *_it / *_audit database.
import { AppUser, Prisma, PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { AdminAuditService } from '../../src/admin/auth/admin-audit.service';
import { OrderStatusService } from '../../src/orders/order-status.service';
import { OrdersService } from '../../src/orders/orders.service';
import { DiscountService } from '../../src/sales/discount.service';
import {
  fakeConfig,
  fakeDeliveryQuotes,
  fakeNotifications,
  fakeRealtime,
} from '../utils/harness';
import { describeWithDb, integrationPrisma } from '../utils/integration-db';

const run = randomBytes(3).toString('hex');
const PICKUP = {
  cart_snapshot: { delivery_method: 'pickup' },
  payment_type: 'cash',
} as never;
const TERMINAL = {
  cart_snapshot: { delivery_method: 'pickup' },
  payment_type: 'terminal',
} as never;
const key = () => `it_${run}_${randomBytes(6).toString('hex')}`;

describeWithDb('Checkout idempotency (real PostgreSQL)', () => {
  // Created in beforeAll, so that without a database the suite is skipped, not failed.
  let prisma: PrismaClient;
  const sellerId = `it-idem-seller-${run}`;
  const partId = `it-idem-part-${run}`;
  const categoryId = `it-idem-cat-${run}`;
  const users: AppUser[] = [];

  beforeAll(async () => {
    prisma = integrationPrisma();
    users.push(await prisma.appUser.create({ data: { id: randomUUID() } }));
    users.push(await prisma.appUser.create({ data: { id: randomUUID() } }));
    await prisma.catalogSeller.create({
      data: { id: sellerId, name: sellerId },
    });
    await prisma.partCategory.create({
      data: {
        id: categoryId,
        slug: categoryId,
        name: categoryId,
        nameRu: 'r',
        nameUz: 'u',
        nameEn: 'e',
      },
    });
    await prisma.catalogPart.create({
      data: {
        id: partId,
        title: partId,
        categoryId,
        sellerId,
        priceUzs: 1000,
        stockQty: 1000,
        inStock: true,
        oemNumbers: [],
        gmNumbers: [],
        images: ['https://cdn/x.webp'],
      },
    });
  });

  afterAll(async () => {
    const ids = users.map((u) => u.id);
    await prisma.orderIdempotency.deleteMany({
      where: { userId: { in: ids } },
    });
    await prisma.$executeRaw`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE user_id = ANY(${ids}::uuid[]))`;
    await prisma.$executeRaw`DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE user_id = ANY(${ids}::uuid[]))`;
    await prisma.order.deleteMany({ where: { userId: { in: ids } } });
    await prisma.cart.deleteMany({ where: { userId: { in: ids } } });
    await prisma.catalogPart.deleteMany({ where: { sellerId } });
    await prisma.partCategory.delete({ where: { id: categoryId } });
    await prisma.catalogSeller.delete({ where: { id: sellerId } });
    await prisma.appUser.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  const service = () =>
    new OrdersService(
      prisma as never,
      fakeConfig() as never,
      fakeNotifications() as never,
      fakeRealtime() as never,
      new OrderStatusService(prisma as never),
      new DiscountService(prisma as never),
      new AdminAuditService(prisma as never),
      fakeDeliveryQuotes() as never,
    );

  async function fillCart(user: AppUser) {
    await prisma.cart.deleteMany({ where: { userId: user.id } });
    const id = `it-idem-cart-${randomBytes(4).toString('hex')}`;
    await prisma.cart.create({
      data: {
        id,
        userId: user.id,
        items: {
          create: {
            id: `it-idem-line-${id}`,
            partId,
            title: 'Part',
            priceUzsSnapshot: new Prisma.Decimal(1000),
            quantity: 1,
          },
        },
      },
    });
  }
  const ordersOf = (user: AppUser) =>
    prisma.order.count({ where: { userId: user.id } });

  it('ten simultaneous checkouts with one key: one order, one key row, the same id everywhere', async () => {
    const [user] = users;
    await fillCart(user);
    const before = await ordersOf(user);
    const k = key();
    const orders = service();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => orders.checkout(user.id, PICKUP, k)),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toEqual([]);
    const ids = new Set(
      results.map(
        (r) => (r as PromiseFulfilledResult<any>).value.order.order_id,
      ),
    );
    expect(ids.size).toBe(1);
    expect((await ordersOf(user)) - before).toBe(1);
    expect(
      await prisma.orderIdempotency.count({
        where: { userId: user.id, idempotencyKey: k },
      }),
    ).toBe(1);
  });

  it('a retry after the cart was emptied, and after it was refilled, returns the original order', async () => {
    const [user] = users;
    await fillCart(user);
    const k = key();
    const orders = service();
    const first = await orders.checkout(user.id, PICKUP, k);
    const before = await ordersOf(user);

    const emptied = await orders.checkout(user.id, PICKUP, k);
    await fillCart(user);
    const refilled = await orders.checkout(user.id, PICKUP, k);

    expect(emptied).toMatchObject({
      replayed: true,
      order: { order_id: first.order.order_id },
    });
    expect(refilled).toMatchObject({
      replayed: true,
      order: { order_id: first.order.order_id },
    });
    expect(await ordersOf(user)).toBe(before);
    expect(
      await prisma.cartItem.count({ where: { cart: { userId: user.id } } }),
    ).toBe(1);
  });

  it('the same key with a different request is 409 IDEMPOTENCY_KEY_REUSED and creates nothing', async () => {
    const [user] = users;
    await fillCart(user);
    const k = key();
    const orders = service();
    await orders.checkout(user.id, PICKUP, k);
    await fillCart(user);
    const before = await ordersOf(user);

    await expect(orders.checkout(user.id, TERMINAL, k)).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
    expect(await ordersOf(user)).toBe(before);
  });

  it('another buyer may use the same key for their own checkout', async () => {
    const [a, b] = users;
    const k = key();
    const orders = service();
    await fillCart(a);
    await fillCart(b);

    const mine = await orders.checkout(a.id, PICKUP, k);
    const theirs = await orders.checkout(b.id, PICKUP, k);

    expect(theirs.replayed).toBe(false);
    expect(theirs.order.order_id).not.toBe(mine.order.order_id);
  });

  it('the database refuses a second row for one (user, key), even without the service', async () => {
    const [user] = users;
    await fillCart(user);
    const k = key();
    const placed = await service().checkout(user.id, PICKUP, k);
    const other = await prisma.order.findFirstOrThrow({
      where: { userId: user.id, id: { not: placed.order.order_id } },
    });

    await expect(
      prisma.orderIdempotency.create({
        data: {
          userId: user.id,
          idempotencyKey: k,
          payloadHash: 'f'.repeat(64),
          orderId: other.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a failure inside the transaction leaves neither an order nor a key row', async () => {
    const [user] = users;
    await fillCart(user);
    const k = key();
    const before = await ordersOf(user);
    // The price moves between pricing and the locked re-check, so the transaction throws
    // after it has started writing nothing yet visible to anyone else.
    const orders = service();
    const spy = jest
      .spyOn(orders as any, 'assertPricesStillCurrent')
      .mockRejectedValueOnce(
        new Error('injected failure inside the transaction'),
      );

    await expect(orders.checkout(user.id, PICKUP, k)).rejects.toThrow(
      'injected failure',
    );
    spy.mockRestore();

    expect(await ordersOf(user)).toBe(before);
    expect(
      await prisma.orderIdempotency.count({
        where: { userId: user.id, idempotencyKey: k },
      }),
    ).toBe(0);
    expect(
      await prisma.cartItem.count({ where: { cart: { userId: user.id } } }),
    ).toBe(1);
  });

  it('an expired key is refused and stays; the row goes only with its order (ON DELETE CASCADE)', async () => {
    const [user] = users;
    await fillCart(user);
    const k = key();
    const orders = service();
    const placed = await orders.checkout(user.id, PICKUP, k);
    await prisma.orderIdempotency.update({
      where: { orderId: placed.order.order_id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await fillCart(user);
    const before = await ordersOf(user);

    await expect(orders.checkout(user.id, PICKUP, k)).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_EXPIRED' },
    });
    expect(await ordersOf(user)).toBe(before);

    await prisma.$executeRaw`DELETE FROM order_status_history WHERE order_id = ${placed.order.order_id}`;
    await prisma.$executeRaw`DELETE FROM inventory_reservations WHERE order_id = ${placed.order.order_id}`;
    await prisma.order.delete({ where: { id: placed.order.order_id } });
    expect(
      await prisma.orderIdempotency.count({
        where: { userId: user.id, idempotencyKey: k },
      }),
    ).toBe(0);
  });
});
