// The rules around prices, stock, sales and brand deletes, against a real PostgreSQL,
// including what happens when two writers meet.
//
// Run with TEST_DATABASE_URL set; see admin-categories.int-spec.ts.

import { ConflictException } from '@nestjs/common';
import {
  AdminAuditAction,
  OrderStatus,
  PaymentType,
  Prisma,
  SaleDiscountType,
  SaleScopeType,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { AdminAuditService } from '../../src/admin/auth/admin-audit.service';
import { AdminBrandsService } from '../../src/admin/brands/admin-brands.service';
import { AdminCategoriesService } from '../../src/admin/categories/admin-categories.service';
import { AdminInventoryService } from '../../src/admin/inventory/admin-inventory.service';
import { buyerListed } from '../../src/catalog/buyer-visibility';
import { PartCategoryService } from '../../src/catalog/categories/part-category.service';
import { CatalogProjectionService } from '../../src/catalog/projection/catalog-projection.service';
import { findUnavailableParts } from '../../src/orders/order-availability';
import { OrderStatusService } from '../../src/orders/order-status.service';
import { OrdersService } from '../../src/orders/orders.service';
import { CacheService } from '../../src/redis/cache.service';
import { DiscountService } from '../../src/sales/discount.service';
import { fakeConfig, fakeRedis } from '../utils/harness';
import { describeWithDb, integrationPrisma } from '../utils/integration-db';

const run = randomBytes(3).toString('hex');
const PREFIX = `it-${run}-`;
const rowId = (name: string) => `${PREFIX}${name}`;
const ACTOR = {
  id: rowId('actor'),
  email: `${rowId('actor')}@mator.test`,
  name: 'Operator',
};

describeWithDb('catalog safety (real PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const cache = new CacheService(fakeRedis() as never);
  const tree = new PartCategoryService(prisma as never, cache);
  const audit = new AdminAuditService(prisma as never);
  const categories = new AdminCategoriesService(prisma as never, tree, audit);
  const inventory = new AdminInventoryService(prisma as never, audit);
  const brands = new AdminBrandsService(prisma as never, cache, audit);
  const projection = new CatalogProjectionService(prisma as never);
  const statuses = new OrderStatusService(prisma as never);
  const orders = new OrdersService(
    prisma as never,
    fakeConfig() as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    { emit: jest.fn() } as never,
    statuses,
    new DiscountService(prisma as never),
    audit,
  );

  let dealerId: string;
  let sellerId: number;
  let categoryId: string;

  const category = (name: string) =>
    prisma.partCategory.create({
      data: {
        id: rowId(name),
        slug: rowId(name),
        name,
        nameRu: name,
        nameUz: name,
        nameEn: name,
      },
    });

  const part = (
    name: string,
    over: Partial<Prisma.CatalogPartUncheckedCreateInput> = {},
  ) =>
    prisma.catalogPart.create({
      data: {
        id: rowId(name),
        title: name,
        categoryId,
        sellerId: dealerId,
        priceUzs: 100_000,
        stockQty: 5,
        oemNumbers: [],
        gmNumbers: [],
        images: ['https://cdn/x.webp'],
        ...over,
      },
    });

  beforeAll(async () => {
    await prisma.appAdmin.create({
      data: { ...ACTOR, passwordHash: 'not-a-real-hash' },
    });
    dealerId = rowId('dealer');
    await prisma.catalogSeller.create({
      data: { id: dealerId, name: 'IT dealer' },
    });
    const seller = await prisma.seller.create({
      data: {
        tgId: BigInt(`7${Date.now()}`),
        phone: '+998900000002',
        storeName: `${PREFIX}store`,
      },
    });
    sellerId = seller.id;
  });

  beforeEach(async () => {
    categoryId = (await category('cat')).id;
  });

  afterEach(async () => {
    await prisma.fitmentBinding.deleteMany({
      where: { partId: { startsWith: PREFIX } },
    });
    await prisma.stock.deleteMany({ where: { sellerId } });
    await prisma.orderItem.deleteMany({
      where: { partId: { startsWith: PREFIX } },
    });
    await prisma.order.deleteMany({
      where: {
        id: { startsWith: 'ord_' },
        user: { email: { startsWith: PREFIX } },
      },
    });
    await prisma.cart.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.appUser.deleteMany({
      where: { email: { startsWith: PREFIX } },
    });
    await prisma.catalogPart.deleteMany({
      where: {
        OR: [
          { id: { startsWith: PREFIX } },
          { sellerId: `seller_${sellerId}` },
        ],
      },
    });
    await prisma.catalogSeller.deleteMany({
      where: { id: `seller_${sellerId}` },
    });
    await prisma.product.deleteMany({
      where: { title: { startsWith: PREFIX } },
    });
    await prisma.sale.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.adminAudit.deleteMany({
      where: { targetEntityId: { startsWith: PREFIX } },
    });
    await prisma.vehicleMake.deleteMany({
      where: { id: { startsWith: PREFIX } },
    });
    await prisma.partCategory.deleteMany({
      where: { id: { startsWith: PREFIX } },
    });
  });

  afterAll(async () => {
    await prisma.appAdmin.deleteMany({ where: { id: ACTOR.id } });
    await prisma.catalogSeller.deleteMany({ where: { id: dealerId } });
    await prisma.seller.deleteMany({ where: { id: sellerId } });
    await prisma.$disconnect();
  });

  describe('a live sale on a category', () => {
    const sale = (name: string, over: Partial<Prisma.SaleCreateInput> = {}) =>
      prisma.sale.create({
        data: {
          id: rowId(name),
          title: `Sale ${name}`,
          discountType: SaleDiscountType.PERCENT,
          discountValue: 10,
          scopeType: SaleScopeType.CATEGORIES,
          startAt: new Date(Date.now() - 1000),
          targets: {
            create: [
              {
                id: rowId(`${name}-t`),
                targetType: SaleScopeType.CATEGORIES,
                targetId: categoryId,
              },
            ],
          },
          ...over,
        },
      });

    it('blocks the delete, naming the sale', async () => {
      await sale('live');

      await expect(categories.remove(categoryId)).rejects.toThrow(/Sale live/);
      expect(
        await prisma.partCategory.findUnique({ where: { id: categoryId } }),
      ).not.toBeNull();
    });

    it('a sale that is switched off still blocks: it can be switched back on', async () => {
      await sale('off', { isActive: false });

      await expect(categories.remove(categoryId)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it.each([
      ['has ended', { endAt: new Date(Date.now() - 500) }],
      ['was deleted', { deletedAt: new Date() }],
    ])('a sale that %s does not', async (_label, over) => {
      await sale('old', over);

      await categories.remove(categoryId);

      expect(
        await prisma.partCategory.findUnique({ where: { id: categoryId } }),
      ).toBeNull();
    });
  });

  describe('deleting a brand or model with fitment work behind it', () => {
    const fixture = async () => {
      const make = await prisma.vehicleMake.create({
        data: { id: rowId('make'), name: rowId('make') },
      });
      const model = await prisma.vehicleModelRef.create({
        data: { id: rowId('model'), makeId: make.id, name: 'M' },
      });
      const p = await part('bound');
      const node = await prisma.vehicleNode.upsert({
        where: { category: 'FRONT_BRAKES' },
        update: {},
        create: {
          category: 'FRONT_BRAKES',
          name: 'n',
          positionX: 0,
          positionY: 0,
          positionZ: 0,
        },
      });
      await prisma.fitmentBinding.create({
        data: { partId: p.id, vehicleModelId: model.id, nodeId: node.id },
      });
      return { make, model };
    };

    it('the preview says what would be lost', async () => {
      const { make, model } = await fixture();

      expect((await brands.deletePreview(make.id)).data).toEqual({
        models: 1,
        fitmentBindings: 1,
        vehicles: 0,
      });
      expect((await brands.modelDeletePreview(model.id)).data).toEqual({
        fitmentBindings: 1,
        vehicles: 0,
      });
    });

    it('refuses unless the number is stated, and refuses a stale number', async () => {
      const { make, model } = await fixture();

      await expect(brands.remove(make.id)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'FITMENT_WOULD_BE_LOST' }),
      });
      await expect(brands.remove(make.id, 5)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(brands.removeModel(model.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(
        await prisma.fitmentBinding.count({
          where: { vehicleModelId: model.id },
        }),
      ).toBe(1);
    });

    it('goes ahead when accepted, and leaves an audit entry', async () => {
      const { make } = await fixture();

      await brands.remove(make.id, 1, { actor: ACTOR });

      expect(
        await prisma.vehicleMake.findUnique({ where: { id: make.id } }),
      ).toBeNull();
      const entry = await prisma.adminAudit.findFirstOrThrow({
        where: {
          action: AdminAuditAction.BRAND_DELETED,
          targetEntityId: make.id,
        },
      });
      expect(entry.actorEmail).toBe(ACTOR.email);
      expect(entry.previousValues).toMatchObject({ fitmentBindings: 1 });
    });

    it('a brand with nothing behind it deletes as before, with no extra step', async () => {
      const make = await prisma.vehicleMake.create({
        data: { id: rowId('empty-make'), name: rowId('empty-make') },
      });

      await brands.remove(make.id);

      expect(
        await prisma.vehicleMake.findUnique({ where: { id: make.id } }),
      ).toBeNull();
    });
  });

  describe('a price of zero', () => {
    it('the checkout gate refuses a part priced at 0', async () => {
      const free = await part('free', { priceUzs: 0 });
      const paid = await part('paid');

      const unavailable = await findUnavailableParts(prisma as never, [
        { partId: free.id, title: 'free' },
        { partId: paid.id, title: 'paid' },
      ]);

      expect(unavailable).toEqual([
        { partId: free.id, title: 'free', reason: 'no_price' },
      ]);
    });

    it('the buyer catalog does not list it', async () => {
      const free = await part('free', { priceUzs: 0 });
      const paid = await part('paid');

      const rows = await prisma.catalogPart.findMany({
        where: buyerListed({ id: { in: [free.id, paid.id] } }),
        select: { id: true },
      });

      expect(rows.map((r) => r.id)).toEqual([paid.id]);
    });

    it('a sale that would make a line free stops the order', async () => {
      const p = await part('discounted');
      const user = await prisma.appUser.create({
        data: { email: `${PREFIX}buyer@mator.test` },
      });
      await prisma.cart.create({
        data: {
          id: rowId('cart'),
          userId: user.id,
          items: {
            create: [
              {
                id: rowId('line'),
                partId: p.id,
                title: 'discounted',
                priceUzsSnapshot: 100_000,
              },
            ],
          },
        },
      });
      await prisma.sale.create({
        data: {
          id: rowId('big-sale'),
          title: 'Too big',
          discountType: SaleDiscountType.FIXED,
          discountValue: 500_000,
          scopeType: SaleScopeType.PRODUCTS,
          startAt: new Date(Date.now() - 1000),
          targets: {
            create: [
              {
                id: rowId('big-sale-t'),
                targetType: SaleScopeType.PRODUCTS,
                targetId: p.id,
              },
            ],
          },
        },
      });

      await expect(
        orders.createFromCart(user.id, { payment_type: 'cash' } as never),
      ).rejects.toThrow(/no_price/);
    });
  });

  describe('inventory edits', () => {
    it('records old and new values per part, and nothing for a no-op', async () => {
      const a = await part('a');
      const b = await part('b');

      await inventory.batchUpdate(
        {
          items: [
            { id: a.id, retailPrice: 120_000, stock: 2 },
            { id: b.id, retailPrice: 100_000 }, // the price it already has
          ],
        },
        { actor: ACTOR, ip: '203.0.113.9' },
      );

      const entry = await prisma.adminAudit.findFirstOrThrow({
        where: {
          action: AdminAuditAction.INVENTORY_UPDATED,
          targetEntityId: a.id,
        },
      });
      expect(entry.actorEmail).toBe(ACTOR.email);
      expect(entry.previousValues).toEqual({ retailPrice: 100_000, stock: 5 });
      expect(entry.newValues).toEqual({ retailPrice: 120_000, stock: 2 });
      expect(
        await prisma.adminAudit.count({ where: { targetEntityId: b.id } }),
      ).toBe(0);
    });

    it('is all or nothing: one failing row leaves every row and no audit', async () => {
      const a = await part('a');
      const c = await part('c');

      await expect(
        inventory.batchUpdate(
          {
            items: [
              { id: c.id, retailPrice: 5 },
              { id: a.id, cashbackPct: 1e9 }, // past the column's bound
            ],
          },
          { actor: ACTOR },
        ),
      ).rejects.toThrow();

      const row = await prisma.catalogPart.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(Number(row.priceUzs)).toBe(100_000);
      expect(
        await prisma.adminAudit.count({ where: { targetEntityId: c.id } }),
      ).toBe(0);
    });

    it('a price edit racing an import sync leaves a consistent row, never a torn one', async () => {
      const product = await prisma.product.create({
        data: { title: `${PREFIX}imported` },
      });
      const stock = await prisma.stock.create({
        data: {
          sellerId,
          productId: product.id,
          priceUzs: 50_000,
          quantity: 7,
          sourceSystem: 'DRIVERS_VILLAGE_1C',
          sourceCode: rowId('code'),
        },
      });
      const partId = (await projection.projectStock(stock.id))!;

      for (let i = 0; i < 15; i += 1) {
        await Promise.all([
          inventory.batchUpdate({
            items: [{ id: partId, retailPrice: 77_000 + i, stock: 0 }],
          }),
          projection.projectStockLevels(stock.id, {
            price: true,
            quantity: true,
          }),
        ]);
        const row = await prisma.catalogPart.findUniqueOrThrow({
          where: { id: partId },
        });
        // Whoever wrote last, its price and stock arrived together.
        const importWonPrice = Number(row.priceUzs) === 50_000;
        expect(row.stockQty).toBe(importWonPrice ? 7 : 0);
        expect(row.inStock).toBe(row.stockQty > 0);
      }
    });
  });

  describe('two customers, one last unit', () => {
    const buyerWithCart = async (name: string, partId: string) => {
      const user = await prisma.appUser.create({
        data: { email: `${PREFIX}${name}@mator.test` },
      });
      await prisma.cart.create({
        data: {
          id: rowId(`cart-${name}`),
          userId: user.id,
          items: {
            create: [
              {
                id: rowId(`line-${name}`),
                partId,
                title: 'last one',
                priceUzsSnapshot: 100_000,
              },
            ],
          },
        },
      });
      return user;
    };

    // Characterizes today's behaviour rather than a wish: there is no reservation, so
    // both orders go through and the operator resolves it when confirming. Stock is
    // the dealer's, updated from 1C a few times a day, so nothing here can promise
    // the unit exists. If reservation is ever added, this test is meant to change.
    it('both orders are accepted; neither touches the stock count', async () => {
      const p = await part('last', { stockQty: 1 });
      const [a, b] = await Promise.all([
        buyerWithCart('a', p.id),
        buyerWithCart('b', p.id),
      ]);

      const results = await Promise.all([
        orders.createFromCart(a.id, { payment_type: 'cash' } as never),
        orders.createFromCart(b.id, { payment_type: 'cash' } as never),
      ]);

      expect(results.map((r) => r.status)).toEqual([
        'pending_payment',
        'pending_payment',
      ]);
      const created = await prisma.order.findMany({
        where: { id: { in: results.map((r) => r.order_id) } },
        select: { paymentType: true, status: true },
      });
      expect(
        created.every((o) => o.status === OrderStatus.PENDING_PAYMENT),
      ).toBe(true);
      expect(created.every((o) => o.paymentType === PaymentType.CASH)).toBe(
        true,
      );
      expect(
        (await prisma.catalogPart.findUniqueOrThrow({ where: { id: p.id } }))
          .stockQty,
      ).toBe(1);
    });

    it('once the part is out of stock, the next checkout is refused', async () => {
      const p = await part('gone', { stockQty: 0, inStock: false });
      const buyer = await buyerWithCart('c', p.id);

      await expect(
        orders.createFromCart(buyer.id, { payment_type: 'cash' } as never),
      ).rejects.toThrow(/out_of_stock/);
    });
  });
});
