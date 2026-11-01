// DELETE /v1/admin/categories/:id and the tree rules, against a real PostgreSQL.
//
// Run with:
//   TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/mator_it \
//     npm run test:integration
//
// The FK actions these specs depend on (RESTRICT on catalog_parts.category_id,
// SET NULL on products / product_drafts / part_categories.parent_id) and the
// races they close cannot be observed through a Prisma mock.

import {
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { DraftStatus, PartMainCategory, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AdminAuditService } from '../../src/admin/auth/admin-audit.service';
import { AdminCategoriesService } from '../../src/admin/categories/admin-categories.service';
import { AdminInventoryService } from '../../src/admin/inventory/admin-inventory.service';
import { AdminProductsRatingService } from '../../src/admin/products/admin-products-rating.service';
import { PartCategoryService } from '../../src/catalog/categories/part-category.service';
import { CatalogProjectionService } from '../../src/catalog/projection/catalog-projection.service';
import { CacheService } from '../../src/redis/cache.service';
import { RedisKeys } from '../../src/redis/redis.keys';
import { fakeRedis } from '../utils/harness';
import {
  describeWithDb,
  integrationPrisma,
  whileUncommitted,
} from '../utils/integration-db';

const run = randomBytes(3).toString('hex');
const PREFIX = `it-${run}-`;
const rowId = (name: string) => `${PREFIX}${name}`;

describeWithDb(
  'admin category delete and tree writes (real PostgreSQL)',
  () => {
    const prisma = integrationPrisma();
    const redis = fakeRedis() as { store: Map<string, unknown> };
    const cache = new CacheService(redis as never);
    const tree = new PartCategoryService(prisma as never, cache);
    const audit = new AdminAuditService(prisma as never);
    const service = new AdminCategoriesService(prisma as never, tree, audit);
    const projection = new CatalogProjectionService(prisma as never);
    const inventory = new AdminInventoryService(prisma as never, audit);
    const ratings = new AdminProductsRatingService(prisma as never, projection);

    let dealerId: string;
    let sellerId: number;

    const category = (
      name: string,
      over: Partial<Prisma.PartCategoryUncheckedCreateInput> = {},
    ) =>
      prisma.partCategory.create({
        data: {
          id: rowId(name),
          slug: rowId(name),
          name,
          nameRu: name,
          nameUz: name,
          nameEn: name,
          level: over.parentId ? 1 : 0,
          ...over,
        },
      });

    const part = (name: string, categoryId: string) =>
      prisma.catalogPart.create({
        data: {
          id: rowId(name),
          title: name,
          categoryId,
          sellerId: dealerId,
          priceUzs: 100_000,
          oemNumbers: [],
          gmNumbers: [],
          images: [],
        },
      });

    const listing = (
      name: string,
      over: Partial<Prisma.ProductUncheckedCreateInput> = {},
    ) =>
      prisma.product.create({ data: { title: `${PREFIX}${name}`, ...over } });

    const draft = (name: string, status: DraftStatus, categoryId: string) =>
      prisma.productDraft.create({
        data: {
          id: rowId(name),
          sellerId,
          tgId: BigInt(1),
          status,
          formStep: 'PHOTOS_FIRST',
          expiresAt: new Date(Date.now() + 86_400_000),
          categoryId,
        },
      });

    const exists = async (id: string) =>
      (
        await prisma.$queryRaw<
          { n: bigint }[]
        >`SELECT COUNT(*)::bigint AS n FROM "part_categories" WHERE "id" = ${id}`
      )[0].n === 1n;

    beforeAll(async () => {
      dealerId = rowId('dealer');
      await prisma.catalogSeller.create({
        data: { id: dealerId, name: 'IT dealer' },
      });
      const seller = await prisma.seller.create({
        data: {
          tgId: BigInt(`9${Date.now()}`),
          phone: '+998900000000',
          storeName: `${PREFIX}store`,
        },
      });
      sellerId = seller.id;
    });

    afterEach(async () => {
      redis.store.clear();
      await prisma.stock.deleteMany({ where: { sellerId } });
      await prisma.catalogPart.deleteMany({
        where: {
          OR: [
            { id: { startsWith: PREFIX } },
            { categoryId: { startsWith: PREFIX } },
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
      await prisma.productDraft.deleteMany({
        where: { id: { startsWith: PREFIX } },
      });
      await prisma.partCategory.deleteMany({
        where: { id: { startsWith: PREFIX } },
      });
    });

    afterAll(async () => {
      await prisma.catalogSeller.deleteMany({ where: { id: dealerId } });
      await prisma.seller.deleteMany({ where: { id: sellerId } });
      await prisma.$disconnect();
    });

    describe('a delete removes the row, and only when nothing depends on it', () => {
      it('physically removes an unreferenced leaf: no soft delete, row gone', async () => {
        const leaf = await category('leaf');

        const res = await service.remove(leaf.id);

        expect(res).toEqual({
          success: true,
          data: { deleted: leaf.id, reassigned: 0 },
        });
        expect(await exists(leaf.id)).toBe(false);
      });

      it('404s on an id that does not exist', async () => {
        await expect(service.remove(rowId('ghost'))).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });

      it('a category with parts needs a target: 409 leaves everything in place', async () => {
        const cat = await category('with-parts');
        const p = await part('p1', cat.id);

        await expect(service.remove(cat.id)).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(await exists(cat.id)).toBe(true);
        const after = await prisma.catalogPart.findUnique({
          where: { id: p.id },
        });
        expect(after?.categoryId).toBe(cat.id);
      });

      it('reassignTo moves the parts and deletes in one transaction', async () => {
        const from = await category('from');
        const to = await category('to');
        const p = await part('p2', from.id);

        const res = await service.remove(from.id, to.id);

        expect(res.data).toEqual({ deleted: from.id, reassigned: 1 });
        expect(await exists(from.id)).toBe(false);
        const moved = await prisma.catalogPart.findUnique({
          where: { id: p.id },
        });
        expect(moved?.categoryId).toBe(to.id);
      });

      it('an unknown reassign target moves nothing and deletes nothing', async () => {
        const cat = await category('keep');
        const p = await part('p3', cat.id);

        await expect(
          service.remove(cat.id, rowId('no-such-target')),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(await exists(cat.id)).toBe(true);
        const after = await prisma.catalogPart.findUnique({
          where: { id: p.id },
        });
        expect(after?.categoryId).toBe(cat.id);
      });

      it('a category with children is refused and the child keeps its parent', async () => {
        const parent = await category('parent');
        const child = await category('child', { parentId: parent.id });

        await expect(service.remove(parent.id)).rejects.toBeInstanceOf(
          ConflictException,
        );

        const after = await prisma.partCategory.findUnique({
          where: { id: child.id },
        });
        expect(after?.parentId).toBe(parent.id);
      });

      it.each(['categoryId', 'vehicleCategoryId'] as const)(
        'a listing pointing here through %s blocks the delete and keeps its filing',
        async (column) => {
          const cat = await category(`listed-${column}`);
          const product = await listing(`l-${column}`, { [column]: cat.id });

          await expect(service.remove(cat.id)).rejects.toBeInstanceOf(
            ConflictException,
          );

          const after = await prisma.product.findUnique({
            where: { id: product.id },
          });
          expect(after?.[column]).toBe(cat.id);
        },
      );
    });

    describe('dead drafts do not pin a category forever', () => {
      it.each([
        DraftStatus.CREATING,
        DraftStatus.READY_FOR_PREVIEW,
        DraftStatus.COMMITTING,
      ])('a live %s draft blocks the delete', async (status) => {
        const cat = await category(`live-${status}`);
        await draft(`d-${status}`, status, cat.id);

        await expect(service.remove(cat.id)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(await exists(cat.id)).toBe(true);
      });

      it.each([
        DraftStatus.CANCELLED,
        DraftStatus.EXPIRED,
        DraftStatus.PUBLISHED,
      ])(
        'a %s draft does not: the row is deleted and the draft loses only the FK',
        async (status) => {
          const cat = await category(`dead-${status}`);
          const d = await draft(`d-${status}`, status, cat.id);

          await service.remove(cat.id);

          expect(await exists(cat.id)).toBe(false);
          const after = await prisma.productDraft.findUnique({
            where: { id: d.id },
          });
          expect(after?.status).toBe(status);
          expect(after?.categoryId).toBeNull();
        },
      );

      it('the tree reports only what actually blocks the delete', async () => {
        const cat = await category('counted');
        await draft('dead-1', DraftStatus.EXPIRED, cat.id);
        await draft('dead-2', DraftStatus.CANCELLED, cat.id);

        const res = await service.findOne(cat.id);
        expect(res.data.listingsCount).toBe(0);

        await draft('live-1', DraftStatus.CREATING, cat.id);
        expect((await service.findOne(cat.id)).data.listingsCount).toBe(1);
      });

      it('listingsCount sees a listing filed through vehicleCategoryId only', async () => {
        const root = await category('vehicle-root');
        await listing('via-vehicle', { vehicleCategoryId: root.id });

        const res = await service.findOne(root.id);
        expect(res.data.listingsCount).toBe(1);
      });

      it('listingsCount does not count one listing twice for a childless root', async () => {
        const root = await category('terminal-root');
        await listing('both', {
          categoryId: root.id,
          vehicleCategoryId: root.id,
        });

        expect((await service.findOne(root.id)).data.listingsCount).toBe(1);
      });
    });

    describe('load-bearing categories cannot be hard-deleted', () => {
      /** A pre-fix run really deletes the seeded row, so it is put back. */
      const withSeededRow = async (id: string, body: () => Promise<void>) => {
        const before = await prisma.partCategory.findUnique({ where: { id } });
        if (!before) throw new Error(`seeded category "${id}" is missing`);
        try {
          await body();
        } finally {
          if (!(await exists(id))) {
            await prisma.partCategory.create({
              data: before,
            });
          }
        }
      };

      it.each(['brakes', 'oil-and-fluids', 'motor-oil', 'other'])(
        'refuses "%s" even though nothing references it by id',
        async (id) => {
          await withSeededRow(id, async () => {
            await expect(service.remove(id)).rejects.toBeInstanceOf(
              ConflictException,
            );
            expect(await exists(id)).toBe(true);
          });
        },
      );

      it('a listing bucketed BRAKES keeps projecting after someone tries to delete the tile', async () => {
        const product = await listing('bucketed', {
          mainCategory: PartMainCategory.BRAKES,
        });
        const stock = await prisma.stock.create({
          data: { sellerId, productId: product.id, priceUzs: 50_000 },
        });

        await withSeededRow('brakes', async () => {
          await service.remove('brakes').catch(() => undefined);

          // The projection files this part on MAIN_CATEGORY_TO_SLUG[BRAKES]. With
          // that row gone it dies on the catalog_parts FK, so the listing never
          // reaches the buyer catalog.
          const partId = await projection.projectStock(stock.id);
          expect(partId).toBe(`part_stock_${stock.id}`);
        });
      });
    });

    describe('references written while the delete is in flight', () => {
      it('a listing committed mid-delete is not silently stripped of its category', async () => {
        const cat = await category('race-listing');
        let productId = 0;

        const outcome = await whileUncommitted(
          prisma,
          async (tx) => {
            const created = await tx.product.create({
              data: { title: `${PREFIX}race-listing`, categoryId: cat.id },
            });
            productId = created.id;
          },
          () => service.remove(cat.id).catch((err: unknown) => err),
        );

        expect(outcome).toBeInstanceOf(ConflictException);
        const after = await prisma.product.findUnique({
          where: { id: productId },
        });
        expect(after?.categoryId).toBe(cat.id);
        expect(await exists(cat.id)).toBe(true);
      });

      it('a child committed mid-delete is not orphaned into a bogus root', async () => {
        const parent = await category('race-parent');
        const childId = rowId('race-child');

        const outcome = await whileUncommitted(
          prisma,
          (tx) =>
            tx.partCategory.create({
              data: {
                id: childId,
                slug: childId,
                name: 'c',
                nameRu: 'c',
                nameUz: 'c',
                nameEn: 'c',
                level: 1,
                parentId: parent.id,
              },
            }),
          () => service.remove(parent.id).catch((err: unknown) => err),
        );

        expect(outcome).toBeInstanceOf(ConflictException);
        const child = await prisma.partCategory.findUnique({
          where: { id: childId },
        });
        expect(child?.parentId).toBe(parent.id);
      });

      it('a part filed mid-delete is a clean 409, never an opaque 500', async () => {
        const cat = await category('race-part');

        const outcome = await whileUncommitted(
          prisma,
          (tx) =>
            tx.catalogPart.create({
              data: {
                id: rowId('race-part-row'),
                title: 'x',
                categoryId: cat.id,
                sellerId: dealerId,
                priceUzs: 1,
                oemNumbers: [],
                gmNumbers: [],
                images: [],
              },
            }),
          () => service.remove(cat.id).catch((err: unknown) => err),
        );

        expect(outcome).toBeInstanceOf(HttpException);
        expect((outcome as HttpException).getStatus()).toBe(409);
        expect(await exists(cat.id)).toBe(true);
      });

      it('two concurrent deletes: one succeeds, the other is a 404, never a 500', async () => {
        const cat = await category('double');

        const results = await Promise.allSettled([
          service.remove(cat.id),
          service.remove(cat.id),
        ]);

        const failures = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        expect(failures).toHaveLength(1);
        expect(failures[0].reason).toBeInstanceOf(NotFoundException);
        expect(await exists(cat.id)).toBe(false);
      });
    });

    describe('deactivating is the safe alternative to deleting', () => {
      it('hides the row from sellers and buyers but keeps everything attached to it', async () => {
        const parent = await category('deact-parent');
        const node = await category('deact-node', { parentId: parent.id });
        const child = await category('deact-child', { parentId: node.id });
        const p = await part('deact-part', node.id);
        const l = await listing('deact-listing', { categoryId: node.id });
        await tree.findChildren(parent.id);
        await tree.findChildren(node.id);

        const answer = await service.setActive(node.id, false);

        expect(answer.data.isActive).toBe(false);
        expect(await exists(node.id)).toBe(true);
        expect(
          (await tree.findChildren(parent.id)).map((c) => c.id),
        ).not.toContain(node.id);
        // The child list a seller past this step reads is dropped as well.
        expect(
          redis.store.has(RedisKeys.cacheReferenceCategoryChildren(node.id)),
        ).toBe(false);
        expect(
          (await prisma.catalogPart.findUniqueOrThrow({ where: { id: p.id } }))
            .categoryId,
        ).toBe(node.id);
        expect(
          (await prisma.product.findUniqueOrThrow({ where: { id: l.id } }))
            .categoryId,
        ).toBe(node.id);
        expect(
          (
            await prisma.partCategory.findUniqueOrThrow({
              where: { id: child.id },
            })
          ).parentId,
        ).toBe(node.id);
        // The panel still shows it, so it can be turned back on.
        const flat = await service.list({});
        expect(flat.data.map((c) => c.id)).toContain(node.id);
      });

      it('is reversible: turning it back on returns it to the lists', async () => {
        const parent = await category('react-parent');
        const node = await category('react-node', { parentId: parent.id });

        await service.setActive(node.id, false);
        await service.setActive(node.id, true);

        expect((await tree.findChildren(parent.id)).map((c) => c.id)).toContain(
          node.id,
        );
      });

      it('a load-bearing category that cannot be deleted can still be deactivated', async () => {
        const before = await prisma.partCategory.upsert({
          where: { id: 'brakes' },
          update: {},
          create: {
            id: 'brakes',
            slug: 'brakes',
            name: 'Brakes',
            nameRu: 'Тормоза',
            nameUz: 'Tormoz',
            nameEn: 'Brakes',
            level: 1,
          },
        });

        await expect(service.setActive('brakes', false)).resolves.toMatchObject(
          {
            data: { isActive: false },
          },
        );

        await prisma.partCategory.update({
          where: { id: 'brakes' },
          data: { isActive: before.isActive },
        });
      });

      it('404s on an id that does not exist', async () => {
        await expect(
          service.setActive(rowId('no-such-category'), false),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('caches and lists follow the delete', () => {
      it('a deleted category leaves the bot and reference caches at once', async () => {
        const parent = await category('cache-parent');
        const leaf = await category('cache-leaf', { parentId: parent.id });

        await tree.findChildren(parent.id);
        await tree.findChildren(leaf.id);
        expect(
          redis.store.has(RedisKeys.cacheReferenceCategoryChildren(leaf.id)),
        ).toBe(true);

        await service.remove(leaf.id);

        expect(
          redis.store.has(RedisKeys.cacheReferenceCategoryChildren(parent.id)),
        ).toBe(false);
        expect(
          redis.store.has(RedisKeys.cacheReferenceCategoryChildren(leaf.id)),
        ).toBe(false);
        expect((await tree.findChildren(parent.id)).map((c) => c.id)).toEqual(
          [],
        );
      });

      it('the tree and the flat list stop returning it', async () => {
        const leaf = await category('listed-leaf');

        await service.remove(leaf.id);

        const flat = await service.list({});
        expect(flat.data.map((c) => c.id)).not.toContain(leaf.id);
        await expect(service.findOne(leaf.id)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });
    });

    describe('the tree stays a tree', () => {
      it('opposite concurrent moves can never produce a cycle', async () => {
        for (let i = 0; i < 12; i += 1) {
          const a = await category(`cycle-a-${i}`);
          const b = await category(`cycle-b-${i}`);

          await Promise.allSettled([
            service.move(a.id, { parentId: b.id }),
            service.move(b.id, { parentId: a.id }),
          ]);

          const [ra, rb] = await Promise.all([
            prisma.partCategory.findUnique({ where: { id: a.id } }),
            prisma.partCategory.findUnique({ where: { id: b.id } }),
          ]);
          const cycle = ra?.parentId === b.id && rb?.parentId === a.id;
          expect(cycle).toBe(false);
        }
      });

      it('moving a subtree past the depth cap is refused, not stored deeper', async () => {
        const r0 = await category('depth-r0');
        const r1 = await category('depth-r1', { parentId: r0.id, level: 1 });
        const r2 = await category('depth-r2', { parentId: r1.id, level: 2 });
        const r3 = await category('depth-r3', { parentId: r2.id, level: 3 });
        const x = await category('depth-x');
        const y = await category('depth-y', { parentId: x.id, level: 1 });
        await category('depth-z', { parentId: y.id, level: 2 });

        // x would land at level 4 (allowed), but its grandchild at level 6.
        await expect(
          service.move(x.id, { parentId: r3.id }),
        ).rejects.toMatchObject({ status: 400 });

        const after = await prisma.partCategory.findUnique({
          where: { id: x.id },
        });
        expect(after?.parentId).toBeNull();
        expect(after?.level).toBe(0);
      });

      it('a move rewrites the level of the whole subtree atomically', async () => {
        const home = await category('level-home');
        const node = await category('level-node');
        const kid = await category('level-kid', {
          parentId: node.id,
          level: 1,
        });

        await service.move(node.id, { parentId: home.id });

        const [n, k] = await Promise.all([
          prisma.partCategory.findUnique({ where: { id: node.id } }),
          prisma.partCategory.findUnique({ where: { id: kid.id } }),
        ]);
        expect(n?.level).toBe(1);
        expect(k?.level).toBe(2);
      });

      it('a slug already taken is a 409, including when it races past the pre-check', async () => {
        const a = await category('slug-a');
        const names = { nameRu: 'x', nameUz: 'x', nameEn: 'x' };

        const results = await Promise.allSettled([
          service.create({ ...names, slug: `${PREFIX}slug-new` }),
          service.create({ ...names, slug: `${PREFIX}slug-new` }),
        ]);
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(ConflictException);

        await expect(
          service.create({ ...names, slug: a.id }),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('one home-grid bucket has one row: a second tile for it is refused', async () => {
        const names = { nameRu: 'x', nameUz: 'x', nameEn: 'x' };

        await expect(
          service.create({
            ...names,
            slug: `${PREFIX}second-brakes`,
            mainCategory: PartMainCategory.BRAKES,
          }),
        ).rejects.toBeInstanceOf(ConflictException);

        const cat = await category('promote');
        await expect(
          service.update(cat.id, { mainCategory: PartMainCategory.BRAKES }),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });

    describe('an operator edit survives a later re-projection', () => {
      it('a rating edit does not revert the retail price or stock set in inventory', async () => {
        const cat = await category('price-cat');
        const product = await listing('priced', { categoryId: cat.id });
        const stock = await prisma.stock.create({
          data: {
            sellerId,
            productId: product.id,
            priceUzs: 50_000,
            quantity: 1,
          },
        });
        const partId = await projection.projectStock(stock.id);

        await inventory.batchUpdate({
          items: [{ id: partId!, retailPrice: 77_000, stock: 9 }],
        });

        await ratings.updateRating(product.id, {
          ratingAvg: 4.5,
          reviewCount: 3,
        });

        const after = await prisma.catalogPart.findUnique({
          where: { id: partId! },
        });
        expect(Number(after?.priceUzs)).toBe(77_000);
        expect(after?.stockQty).toBe(9);
        expect(after?.inStock).toBe(true);
        expect(Number(after?.ratingAvg)).toBe(4.5);
        expect(after?.reviewCount).toBe(3);
      });

      it('bulk-move re-files a part and reports the real number of rows moved', async () => {
        const from = await category('move-from');
        const to = await category('move-to');
        const p = await part('move-part', from.id);

        const res = await service.bulkMoveProducts({
          productIds: [p.id, rowId('does-not-exist')],
          targetCategoryId: to.id,
        });

        expect(res.data.moved).toBe(1);
        const after = await prisma.catalogPart.findUnique({
          where: { id: p.id },
        });
        expect(after?.categoryId).toBe(to.id);
      });
    });
  },
);
