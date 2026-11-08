// What only a real PostgreSQL can show: row locks, conditional updates and the raw
// bulk statement of a FULL sync. Run with TEST_DATABASE_URL; see integration-db.ts.
import { AppUser, Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { AdminAuditService } from '../../src/admin/auth/admin-audit.service';
import { TokenService } from '../../src/auth/tokens/token.service';
import { SyncMode } from '../../src/integrations/dto/sync-inventory.dto';
import { IntegrationsService } from '../../src/integrations/integrations.service';
import { OfflineCollectionService } from '../../src/orders/offline-collection.service';
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
const PICKUP = { cart_snapshot: { delivery_method: 'pickup' } } as never;

describeWithDb('P1 concurrency (real PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const sellerId = `it-seller-${run}`;
  const partId = `it-part-${run}`;
  const categoryId = `it-cat-${run}`;
  let user: AppUser;
  const carts: string[] = [];
  const part = (id: string, oemNumbers: string[]) =>
    prisma.catalogPart.create({
      data: {
        id,
        title: id,
        categoryId,
        sellerId,
        priceUzs: 1000,
        stockQty: 5,
        inStock: true,
        oemNumbers,
        gmNumbers: [],
        images: ['https://cdn/x.webp'],
      },
    });

  beforeAll(async () => {
    user = await prisma.appUser.create({ data: { id: randomUUID() } });
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
    await part(partId, ['ITFULL1']);
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE user_id = ${user.id}::uuid)`;
    await prisma.$executeRaw`DELETE FROM offline_collections WHERE order_id IN (SELECT id FROM orders WHERE user_id = ${user.id}::uuid)`;
    await prisma.$executeRaw`DELETE FROM admin_audits WHERE target_entity_id IN (SELECT id FROM orders WHERE user_id = ${user.id}::uuid)`;
    await prisma.order.deleteMany({ where: { userId: user.id } });
    await prisma.cart.deleteMany({ where: { id: { in: carts } } });
    await prisma.catalogPart.deleteMany({ where: { sellerId } });
    await prisma.partCategory.delete({ where: { id: categoryId } });
    await prisma.catalogSeller.delete({ where: { id: sellerId } });
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await prisma.appUser.delete({ where: { id: user.id } });
    await prisma.$disconnect();
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

  async function cartWithOneLine() {
    await prisma.cart.deleteMany({ where: { userId: user.id } });
    const id = `it-cart-${randomBytes(4).toString('hex')}`;
    carts.push(id);
    await prisma.cart.create({
      data: {
        id,
        userId: user.id,
        items: {
          create: {
            id: `it-line-${id}`,
            partId,
            title: 'Part',
            priceUzsSnapshot: new Prisma.Decimal(1000),
            quantity: 1,
          },
        },
      },
    });
    return id;
  }

  it('two simultaneous checkouts of one cart create one order', async () => {
    await cartWithOneLine();
    const before = await prisma.order.count({ where: { userId: user.id } });

    const results = await Promise.allSettled([
      orders().createFromCart(user.id, PICKUP),
      orders().createFromCart(user.id, PICKUP),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(
      before + 1,
    );
  });

  it('two simultaneous rotations of one token: one succeeds, the other is reuse', async () => {
    const tokens = new TokenService(
      prisma as never,
      { signAsync: jest.fn().mockResolvedValue('jwt') } as never,
      { privateKey: 'k', kid: 'kid' } as never,
      fakeConfig() as never,
      {} as never,
    );
    const { refreshToken } = await tokens.issueSession({
      id: user.id,
      email: null,
      role: 'USER',
      tokenVersion: user.tokenVersion,
    });

    const results = await Promise.allSettled([
      tokens.rotate(refreshToken),
      tokens.rotate(refreshToken),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a FULL sync writes the listed stock and zeroes the rest, in one statement', async () => {
    const other = `it-part2-${run}`;
    await part(other, []);

    const result = await new IntegrationsService(prisma as never).syncInventory(
      {
        id: sellerId,
        name: 'x',
        status: 'ACTIVE',
        apiKeyLast4: '0000',
      } as never,
      {
        mode: SyncMode.FULL,
        expectedTotal: 1,
        items: [{ article: 'ITFULL1', title: 'T', quantity: 9, price: 12.5 }],
      },
    );

    expect(result).toMatchObject({ processedCount: 1, zeroedCount: 1 });
    const [written, zeroed] = await Promise.all([
      prisma.catalogPart.findUnique({ where: { id: partId } }),
      prisma.catalogPart.findUnique({ where: { id: other } }),
    ]);
    expect(written).toMatchObject({ stockQty: 9, inStock: true });
    expect(Number(written!.purchasePriceUzs)).toBe(12.5);
    expect(zeroed).toMatchObject({ stockQty: 0, inStock: false });
  });

  it('two simultaneous collection records count once', async () => {
    const orderId = `it-ord-${randomBytes(4).toString('hex')}`;
    await prisma.order.create({
      data: {
        id: orderId,
        userId: user.id,
        status: 'SHIPPED',
        subtotalUzs: 1000,
        totalUzs: 1000,
        paymentType: 'CASH',
        offlineCollectionRequired: true,
      },
    });
    const service = new OfflineCollectionService(
      prisma as never,
      new AdminAuditService(prisma as never),
    );
    const actor = { id: randomUUID(), email: 'o@x.uz', name: 'O' };
    await Promise.all([
      service.record(orderId, { amountUzs: 1000 }, actor),
      service.record(orderId, { amountUzs: 1000 }, actor),
    ]);
    expect(await prisma.offlineCollection.count({ where: { orderId } })).toBe(
      1,
    );
  });
});
