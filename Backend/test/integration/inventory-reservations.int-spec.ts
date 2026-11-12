// What only a real PostgreSQL can show about reservations: the row locks of order
// creation, and that a rollback takes everything with it. Run with TEST_DATABASE_URL.
// See integration-db.ts.
import { AppUser, Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { AdminAuditService } from '../../src/admin/auth/admin-audit.service';
import { availableUnits } from '../../src/orders/inventory/inventory-availability';
import { reconcileFromSource } from '../../src/orders/inventory/inventory-reservation.store';
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

describeWithDb('Inventory reservations (real PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const sellerId = `it-res-seller-${run}`;
  const categoryId = `it-res-cat-${run}`;
  const users: AppUser[] = [];
  const carts: string[] = [];

  const newPart = (id: string, stockQty: number) =>
    prisma.catalogPart.create({
      data: {
        id,
        title: id,
        categoryId,
        sellerId,
        priceUzs: 1000,
        stockQty,
        inStock: stockQty > 0,
        oemNumbers: [`OEM-${id}`],
        gmNumbers: [],
        images: ['https://cdn/x.webp'],
      },
    });

  const orders = () =>
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

  async function buyerWith(lines: [string, number][]) {
    const user = await prisma.appUser.create({ data: { id: randomUUID() } });
    users.push(user);
    const id = `it-res-cart-${randomBytes(4).toString('hex')}`;
    carts.push(id);
    await prisma.cart.create({
      data: {
        id,
        userId: user.id,
        items: {
          create: lines.map(([partId, quantity], i) => ({
            id: `${id}-${i}`,
            partId,
            title: partId,
            priceUzsSnapshot: new Prisma.Decimal(1000),
            quantity,
          })),
        },
      },
    });
    return user;
  }

  const held = async (partId: string) =>
    (await prisma.catalogPart.findUniqueOrThrow({ where: { id: partId } }))
      .reservedQty;

  beforeAll(async () => {
    process.env.INVENTORY_RESERVATIONS_ENABLED = 'true';
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
  });

  afterAll(async () => {
    delete process.env.INVENTORY_RESERVATIONS_ENABLED;
    const ids = users.map((u) => u.id);
    await prisma.inventoryReservation.deleteMany({ where: { sellerId } });
    await prisma.stockShortageAttempt.deleteMany({ where: { sellerId } });
    await prisma.order.deleteMany({ where: { userId: { in: ids } } });
    await prisma.sourcingTicket.deleteMany({ where: { userId: { in: ids } } });
    await prisma.sourcingRequest.deleteMany({ where: { userId: { in: ids } } });
    await prisma.cart.deleteMany({ where: { id: { in: carts } } });
    await prisma.catalogPart.deleteMany({ where: { sellerId } });
    await prisma.partCategory.delete({ where: { id: categoryId } });
    await prisma.catalogSeller.delete({ where: { id: sellerId } });
    await prisma.appUser.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  const place = (user: AppUser) => orders().createFromCart(user.id, PICKUP);

  it('two buyers, one last unit: exactly one order', async () => {
    const id = `it-res-last-${run}`;
    await newPart(id, 1);
    const [a, b] = [await buyerWith([[id, 1]]), await buyerWith([[id, 1]])];
    const results = await Promise.allSettled([place(a), place(b)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await held(id)).toBe(1);
    expect(
      await prisma.inventoryReservation.count({ where: { partRef: id } }),
    ).toBe(1);
  });

  it('five buyers of 3 against a count of 10 never promise more than 10', async () => {
    const id = `it-res-many-${run}`;
    await newPart(id, 10);
    const buyers = await Promise.all(
      [1, 2, 3, 4, 5].map(() => buyerWith([[id, 3]])),
    );
    const results = await Promise.allSettled(buyers.map(place));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await held(id)).toBe(9);
  });

  it('carts naming the same parts in opposite order do not deadlock', async () => {
    const [p, q] = [`it-res-a-${run}`, `it-res-b-${run}`];
    await newPart(p, 20);
    await newPart(q, 20);
    const buyers = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) =>
        buyerWith(
          i % 2
            ? [
                [p, 1],
                [q, 1],
              ]
            : [
                [q, 1],
                [p, 1],
              ],
        ),
      ),
    );
    const results = await Promise.allSettled(buyers.map(place));
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect(await held(p)).toBe(6);
    expect(await held(q)).toBe(6);
  });

  it('one short line rolls the whole order back', async () => {
    const [ok, short] = [`it-res-ok-${run}`, `it-res-short-${run}`];
    await newPart(ok, 5);
    await newPart(short, 1);
    const buyer = await buyerWith([
      [ok, 1],
      [short, 2],
    ]);
    await expect(place(buyer)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.order.count({ where: { userId: buyer.id } })).toBe(0);
    expect(await held(ok)).toBe(0);
    expect(
      await prisma.inventoryReservation.count({ where: { partRef: ok } }),
    ).toBe(0);
    expect(
      await prisma.cartItem.count({ where: { partId: ok } }),
    ).toBeGreaterThan(0);
  });

  it('a cancelled cash order restores what it held, once', async () => {
    const id = `it-res-cancel-${run}`;
    await newPart(id, 2);
    const buyer = await buyerWith([[id, 2]]);
    const order = (await place(buyer)) as unknown as { order_id: string };
    expect(await held(id)).toBe(2);
    await orders().cancelOwnOrder(buyer.id, order.order_id);
    await orders().cancelOwnOrder(buyer.id, order.order_id);
    expect(await held(id)).toBe(0);
  });

  it('a concurrent new count and sale settle exactly once', async () => {
    const id = `it-res-rec-${run}`;
    await newPart(id, 10);
    const buyer = await buyerWith([[id, 3]]);
    const order = (await place(buyer)) as unknown as { order_id: string };
    await prisma.inventoryReservation.updateMany({
      where: { orderRef: order.order_id },
      data: { status: 'ALLOCATED', allocatedAt: new Date(Date.now() - 60_000) },
    });
    const source = { at: new Date(), ref: 'it-file' };
    await Promise.all(
      [10, 10, 10].map(() =>
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM catalog_parts WHERE id = ${id} FOR NO KEY UPDATE`;
          const part = await tx.catalogPart.findUniqueOrThrow({
            where: { id },
          });
          await tx.catalogPart.update({ where: { id }, data: { stockQty: 7 } });
          await reconcileFromSource(tx, id, part.stockQty, 7, source);
        }),
      ),
    );
    const part = await prisma.catalogPart.findUniqueOrThrow({ where: { id } });
    expect(part.reservedQty).toBe(0);
    expect(availableUnits(part)).toBe(7);
  });
});
