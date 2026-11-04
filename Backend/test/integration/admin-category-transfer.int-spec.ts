// Emptying a category into another, against a real PostgreSQL: what moves, what
// must not change, and what happens when something else writes at the same time.
//
// Run with TEST_DATABASE_URL set; see admin-categories.int-spec.ts.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  DraftStatus,
  PackageForm,
  PartMainCategory,
  PartVehicleCategory,
  Prisma,
  ProductKind,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { AdminAuditService } from '../../src/admin/auth/admin-audit.service';
import { AdminCategoryTransferService } from '../../src/admin/categories/admin-category-transfer.service';
import { AdminCategoriesService } from '../../src/admin/categories/admin-categories.service';
import { PartCategoryService } from '../../src/catalog/categories/part-category.service';
import { CatalogProjectionService } from '../../src/catalog/projection/catalog-projection.service';
import { CacheService } from '../../src/redis/cache.service';
import { fakeRedis } from '../utils/harness';
import {
  describeWithDb,
  integrationPrisma,
  whileUncommitted,
} from '../utils/integration-db';

const run = randomBytes(3).toString('hex');
const PREFIX = `it-${run}-`;
const rowId = (name: string) => `${PREFIX}${name}`;
const ACTOR = {
  id: rowId('actor'),
  email: `${rowId('actor')}@mator.test`,
  name: 'Manager',
};
const REASON = 'Retiring the old subcategory';

describeWithDb('category transfer (real PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const cache = new CacheService(fakeRedis() as never);
  const tree = new PartCategoryService(prisma as never, cache);
  const audit = new AdminAuditService(prisma as never);
  const transfers = new AdminCategoryTransferService(
    prisma as never,
    tree,
    audit,
  );
  const categories = new AdminCategoriesService(prisma as never, tree, audit);
  const projection = new CatalogProjectionService(prisma as never);

  let dealerId: string;
  let sellerId: number;
  let root: string;

  const CONFIGURED = {
    mxik: '08708005011000000',
    packageCodeSingle: '1417722',
  };

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
        level: 1,
        parentId: root,
        ...CONFIGURED,
        ...over,
      },
    });

  const part = (
    name: string,
    categoryId: string,
    over: Partial<Prisma.CatalogPartUncheckedCreateInput> = {},
  ) =>
    prisma.catalogPart.create({
      data: {
        id: rowId(name),
        title: name,
        categoryId,
        sellerId: dealerId,
        priceUzs: 77_000,
        stockQty: 9,
        purchasePriceUzs: 50_000,
        cashbackPct: 3,
        oemNumbers: [],
        gmNumbers: [],
        images: [],
        ...over,
      },
    });

  const listing = (
    name: string,
    over: Partial<Prisma.ProductUncheckedCreateInput> = {},
  ) => prisma.product.create({ data: { title: `${PREFIX}${name}`, ...over } });

  const draft = (
    name: string,
    status: DraftStatus,
    over: Partial<Prisma.ProductDraftUncheckedCreateInput> = {},
  ) =>
    prisma.productDraft.create({
      data: {
        id: rowId(name),
        sellerId,
        tgId: BigInt(1),
        status,
        formStep: 'PHOTOS_FIRST',
        expiresAt: new Date(Date.now() + 86_400_000),
        ...over,
      },
    });

  const preview = async (from: string, to: string) =>
    (await transfers.preview(from, to)).data;

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
        tgId: BigInt(`8${Date.now()}`),
        phone: '+998900000001',
        storeName: `${PREFIX}store`,
      },
    });
    sellerId = seller.id;
  });

  beforeEach(async () => {
    root = rowId('root');
    await prisma.partCategory.create({
      data: {
        id: root,
        slug: root,
        name: 'root',
        nameRu: 'root',
        nameUz: 'root',
        nameEn: 'root',
        level: 0,
      },
    });
  });

  afterEach(async () => {
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
    await prisma.adminAudit.deleteMany({
      where: { targetEntityId: { startsWith: PREFIX } },
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

  describe('preview', () => {
    it('counts everything filed on the source and writes nothing', async () => {
      const from = await category('from');
      const to = await category('to');
      const p = await part('p', from.id);
      const l = await listing('l', {
        categoryId: from.id,
        vehicleCategoryId: root,
      });
      await draft('d-live', DraftStatus.CREATING, { categoryId: from.id });
      await draft('d-dead', DraftStatus.EXPIRED, { categoryId: from.id });

      const plan = await preview(from.id, to.id);

      expect(plan.counts).toMatchObject({
        parts: 1,
        listings: 1,
        liveDrafts: 1,
        finishedDrafts: 1,
        children: 0,
      });
      expect(plan.source.id).toBe(from.id);
      expect(plan.target.id).toBe(to.id);
      expect(plan.target.path).toEqual([to.id, root]);
      expect(plan.canTransfer).toBe(true);

      const [partAfter, listingAfter] = await Promise.all([
        prisma.catalogPart.findUnique({ where: { id: p.id } }),
        prisma.product.findUnique({ where: { id: l.id } }),
      ]);
      expect(partAfter?.categoryId).toBe(from.id);
      expect(listingAfter?.categoryId).toBe(from.id);
    });

    it('404s on an unknown source or target, and refuses the same category', async () => {
      const from = await category('from');
      await expect(
        transfers.preview(rowId('nope'), from.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        transfers.preview(from.id, rowId('nope')),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(transfers.preview(from.id, from.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('warns about subcategories, which stay behind, and an active source', async () => {
      const from = await category('from');
      const to = await category('to');
      await category('kid', { parentId: from.id, level: 2 });

      const plan = await preview(from.id, to.id);

      const codes = plan.warnings.map((w) => w.code);
      expect(codes).toEqual(
        expect.arrayContaining(['SOURCE_HAS_CHILDREN', 'SOURCE_STILL_ACTIVE']),
      );
      expect(plan.canTransfer).toBe(true);
    });
  });

  describe('compatibility', () => {
    const blockerCodes = async (from: string, to: string) =>
      (await preview(from, to)).blockers.map((b) => b.code);

    it('refuses a deactivated target, or one under a deactivated parent', async () => {
      const from = await category('from');
      const off = await category('off', { isActive: false });
      const under = await category('under', { parentId: off.id, level: 2 });

      expect(await blockerCodes(from.id, off.id)).toContain('TARGET_INACTIVE');
      expect(await blockerCodes(from.id, under.id)).toContain(
        'TARGET_INACTIVE',
      );
    });

    it('refuses the fallback bucket: no listing is filed there on purpose', async () => {
      const from = await category('from');

      expect(await blockerCodes(from.id, 'cat_uncategorized')).toContain(
        'TARGET_NOT_A_CATEGORY',
      );
    });

    it('refuses to put oil among spare parts', async () => {
      const from = await category('from');
      const to = await category('to');
      await listing('oil', {
        categoryId: from.id,
        kind: ProductKind.MOTOR_OIL,
      });

      expect(await blockerCodes(from.id, to.id)).toContain('KIND_MISMATCH');
    });

    it('refuses to put spare parts among oils', async () => {
      const from = await category('from');
      await part('pad', from.id);

      expect(await blockerCodes(from.id, 'other')).toContain('KIND_MISMATCH');
    });

    it('refuses a target with no fiscal codes when the source had them', async () => {
      const from = await category('from');
      const to = await category('to', { mxik: null, packageCodeSingle: null });

      expect(await blockerCodes(from.id, to.id)).toContain(
        'TARGET_NOT_FISCALIZED',
      );
    });

    it('allows moving between two categories that both lack fiscal codes', async () => {
      const bare = { mxik: null, packageCodeSingle: null };
      const from = await category('from', bare);
      const to = await category('to', bare);

      expect(await blockerCodes(from.id, to.id)).toEqual([]);
    });

    it('warns when the codes change, and when a set falls back to the single code', async () => {
      const from = await category('from');
      const to = await category('to', { mxik: '00000000000000001' });
      await listing('set', {
        categoryId: from.id,
        packageForm: PackageForm.SET,
      });

      const codes = (await preview(from.id, to.id)).warnings.map((w) => w.code);

      expect(codes).toEqual(
        expect.arrayContaining(['FISCAL_CODES_CHANGE', 'SET_FORM_FALLS_BACK']),
      );
    });

    it('waits for a draft being published right now', async () => {
      const from = await category('from');
      const to = await category('to');
      await draft('committing', DraftStatus.COMMITTING, {
        categoryId: from.id,
      });

      expect(await blockerCodes(from.id, to.id)).toContain('DRAFT_COMMITTING');
      await expect(
        transfers.transfer(from.id, {
          targetCategoryId: to.id,
          reason: REASON,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('the move', () => {
    it('moves parts, listings and live drafts, and re-derives what follows from the node', async () => {
      const from = await category('from', { isActive: false });
      const to = await category('to', { parentId: 'brake-system', level: 1 });
      const p = await part('p', from.id, {
        mainCategory: PartMainCategory.ENGINE,
        vehicleCategory: PartVehicleCategory.ENGINE,
      });
      const l = await listing('l', {
        categoryId: from.id,
        vehicleCategoryId: root,
        mainCategory: PartMainCategory.ENGINE,
        vehicleCategory: PartVehicleCategory.ENGINE,
      });
      const d = await draft('d', DraftStatus.READY_FOR_PREVIEW, {
        categoryId: from.id,
        vehicleCategoryId: root,
        packageForm: PackageForm.SET,
      });

      const res = await transfers.transfer(
        from.id,
        { targetCategoryId: to.id, reason: REASON },
        { actor: ACTOR },
      );

      expect(res.data.moved).toMatchObject({
        parts: 1,
        listings: 1,
        drafts: 1,
      });
      expect(res.data.remaining).toEqual({
        parts: 0,
        listings: 0,
        drafts: 0,
        children: 0,
      });

      const [pAfter, lAfter, dAfter] = await Promise.all([
        prisma.catalogPart.findUniqueOrThrow({ where: { id: p.id } }),
        prisma.product.findUniqueOrThrow({ where: { id: l.id } }),
        prisma.productDraft.findUniqueOrThrow({ where: { id: d.id } }),
      ]);
      expect(pAfter).toMatchObject({
        categoryId: to.id,
        mainCategory: PartMainCategory.BRAKES,
        vehicleCategory: PartVehicleCategory.BRAKE_SYSTEM,
      });
      expect(lAfter).toMatchObject({
        categoryId: to.id,
        vehicleCategoryId: 'brake-system',
        mainCategory: PartMainCategory.BRAKES,
        vehicleCategory: PartVehicleCategory.BRAKE_SYSTEM,
      });
      expect(dAfter).toMatchObject({
        categoryId: to.id,
        vehicleCategoryId: 'brake-system',
        packageForm: null,
      });
    });

    it('never writes price, stock, cashback or photos', async () => {
      const from = await category('from');
      const to = await category('to');
      const p = await part('p', from.id, {
        images: ['https://cdn/x.webp'],
        lowStockThreshold: 3,
      });
      const before = await prisma.catalogPart.findUniqueOrThrow({
        where: { id: p.id },
      });

      await transfers.transfer(from.id, {
        targetCategoryId: to.id,
        reason: REASON,
      });

      const after = await prisma.catalogPart.findUniqueOrThrow({
        where: { id: p.id },
      });
      for (const column of [
        'priceUzs',
        'purchasePriceUzs',
        'cashbackPct',
        'stockQty',
        'inStock',
        'lowStockThreshold',
        'images',
        'oemNumbers',
        'gmNumbers',
      ] as const) {
        expect(after[column]).toEqual(before[column]);
      }
    });

    it('leaves a part an operator already moved elsewhere exactly where it is', async () => {
      const from = await category('from');
      const to = await category('to');
      const manual = await category('manual');
      const product = await listing('l', { categoryId: from.id });
      const p = await part('p', manual.id);

      await transfers.transfer(from.id, {
        targetCategoryId: to.id,
        reason: REASON,
      });

      const [partAfter, productAfter] = await Promise.all([
        prisma.catalogPart.findUniqueOrThrow({ where: { id: p.id } }),
        prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
      ]);
      expect(partAfter.categoryId).toBe(manual.id);
      expect(productAfter.categoryId).toBe(to.id);
    });

    it('a part moved here by hand moves on, without touching a product filed elsewhere', async () => {
      const from = await category('from');
      const to = await category('to');
      const elsewhere = await category('elsewhere');
      const product = await listing('l', { categoryId: elsewhere.id });
      const p = await part('p', from.id);

      await transfers.transfer(from.id, {
        targetCategoryId: to.id,
        reason: REASON,
      });

      expect(
        (await prisma.catalogPart.findUniqueOrThrow({ where: { id: p.id } }))
          .categoryId,
      ).toBe(to.id);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
          .categoryId,
      ).toBe(elsewhere.id);
    });

    it('keeps the enums a kind states for itself: an oil stays an oil on the grid', async () => {
      const oil = await listing('oil', {
        categoryId: 'industrial-oil-does-not-exist-in-migrations' as never,
      }).catch(() => null);
      expect(oil).toBeNull(); // the FK refuses an unknown category

      const from = await category('from', { parentId: 'other' });
      const to = await category('to', { parentId: 'other' });
      const product = await listing('oil', {
        categoryId: from.id,
        kind: ProductKind.MOTOR_OIL,
        mainCategory: PartMainCategory.OIL_AND_FLUIDS,
        vehicleCategory: PartVehicleCategory.MAINTENANCE_AND_FLUIDS,
      });

      await transfers.transfer(from.id, {
        targetCategoryId: to.id,
        reason: REASON,
      });

      expect(
        await prisma.product.findUniqueOrThrow({ where: { id: product.id } }),
      ).toMatchObject({
        categoryId: to.id,
        vehicleCategoryId: 'other',
        mainCategory: PartMainCategory.OIL_AND_FLUIDS,
        vehicleCategory: PartVehicleCategory.MAINTENANCE_AND_FLUIDS,
      });
    });

    it('a finished draft is history and stays as it was', async () => {
      const from = await category('from');
      const to = await category('to');
      const d = await draft('dead', DraftStatus.CANCELLED, {
        categoryId: from.id,
      });

      await transfers.transfer(from.id, {
        targetCategoryId: to.id,
        reason: REASON,
      });

      expect(
        (await prisma.productDraft.findUniqueOrThrow({ where: { id: d.id } }))
          .categoryId,
      ).toBe(from.id);
    });

    it('fixes a listing naming the source as root from outside its subtree, and leaves its own children’s listings', async () => {
      const from = await category('from', { parentId: null, level: 0 });
      const kid = await category('kid', { parentId: from.id, level: 1 });
      const to = await category('to');
      const elsewhere = await category('elsewhere', {
        parentId: 'brake-system',
        level: 1,
      });
      const stale = await listing('stale', {
        categoryId: elsewhere.id,
        vehicleCategoryId: from.id,
      });
      const noNode = await listing('no-node', { vehicleCategoryId: from.id });
      const underKid = await listing('under-kid', {
        categoryId: kid.id,
        vehicleCategoryId: from.id,
      });

      const plan = await preview(from.id, to.id);
      expect(plan.counts.listingRootCorrections).toBe(2);

      const res = await transfers.transfer(from.id, {
        targetCategoryId: to.id,
        reason: REASON,
      });

      expect(res.data.moved.listingRootCorrections).toBe(2);
      expect(res.data.remaining).toMatchObject({ listings: 1, children: 1 });
      const after = (id: number) =>
        prisma.product.findUniqueOrThrow({ where: { id } });
      expect((await after(stale.id)).vehicleCategoryId).toBe('brake-system');
      expect((await after(noNode.id)).vehicleCategoryId).toBe(root);
      expect((await after(underKid.id)).vehicleCategoryId).toBe(from.id);
    });

    it('a re-projection afterwards keeps the part on the new tile', async () => {
      const from = await category('from');
      const to = await category('to', { parentId: 'brake-system', level: 1 });
      const product = await listing('l', {
        categoryId: from.id,
        vehicleCategoryId: root,
        mainCategory: PartMainCategory.ENGINE,
      });
      const stock = await prisma.stock.create({
        data: { sellerId, productId: product.id, priceUzs: 50_000 },
      });
      await projection.projectStock(stock.id);

      await transfers.transfer(from.id, {
        targetCategoryId: to.id,
        reason: REASON,
      });
      await projection.projectStock(stock.id);

      expect(
        await prisma.catalogPart.findUniqueOrThrow({
          where: { id: `part_stock_${stock.id}` },
        }),
      ).toMatchObject({
        categoryId: to.id,
        mainCategory: PartMainCategory.BRAKES,
      });
    });

    it('opens the way for the delete that was impossible before', async () => {
      const from = await category('from');
      const to = await category('to');
      await listing('l', { categoryId: from.id });
      await part('p', from.id);

      await expect(categories.remove(from.id)).rejects.toBeInstanceOf(
        ConflictException,
      );

      await transfers.transfer(from.id, {
        targetCategoryId: to.id,
        reason: REASON,
      });
      await categories.remove(from.id);

      expect(
        await prisma.partCategory.findUnique({ where: { id: from.id } }),
      ).toBeNull();
    });
  });

  describe('safety', () => {
    it('refuses when the numbers changed since the preview', async () => {
      const from = await category('from');
      const to = await category('to');
      await part('p', from.id);
      const seen = await preview(from.id, to.id);
      await part('p2', from.id);

      await expect(
        transfers.transfer(from.id, {
          targetCategoryId: to.id,
          reason: REASON,
          expectedParts: seen.counts.parts,
          expectedListings: seen.counts.listings,
          expectedDrafts: seen.counts.liveDrafts,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'TRANSFER_PREVIEW_STALE' }),
      });
      expect(
        await prisma.catalogPart.count({ where: { categoryId: from.id } }),
      ).toBe(2);
    });

    it('rolls everything back if any part of it fails', async () => {
      const from = await category('from');
      const to = await category('to');
      const p = await part('p', from.id);
      const l = await listing('l', { categoryId: from.id });
      const failingAudit = {
        record: jest.fn().mockRejectedValue(new Error('audit down')),
      };
      const failing = new AdminCategoryTransferService(
        prisma as never,
        tree,
        failingAudit as never,
      );

      await expect(
        failing.transfer(from.id, { targetCategoryId: to.id, reason: REASON }),
      ).rejects.toThrow('audit down');

      expect(
        (await prisma.catalogPart.findUniqueOrThrow({ where: { id: p.id } }))
          .categoryId,
      ).toBe(from.id);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: l.id } }))
          .categoryId,
      ).toBe(from.id);
    });

    it('records who moved what, why, and with what result', async () => {
      const from = await category('from');
      const to = await category('to');
      await part('p', from.id);

      await transfers.transfer(
        from.id,
        { targetCategoryId: to.id, reason: REASON },
        { actor: ACTOR, ip: '203.0.113.9', userAgent: 'it' },
      );

      const entry = await prisma.adminAudit.findFirstOrThrow({
        where: {
          action: AdminAuditAction.CATEGORY_ITEMS_TRANSFERRED,
          targetEntityId: from.id,
        },
      });
      expect(entry).toMatchObject({
        actorEmail: ACTOR.email,
        reason: REASON,
        ip: '203.0.113.9',
      });
      expect(entry.newValues).toMatchObject({
        categoryId: to.id,
        moved: { parts: 1 },
      });
    });

    it('a listing committed mid-transfer waits, then is counted rather than stranded', async () => {
      const from = await category('from');
      const to = await category('to');
      let productId = 0;

      const res = await whileUncommitted(
        prisma,
        async (tx) => {
          const created = await tx.product.create({
            data: { title: `${PREFIX}race`, categoryId: from.id },
          });
          productId = created.id;
        },
        () =>
          transfers.transfer(from.id, {
            targetCategoryId: to.id,
            reason: REASON,
          }),
      );

      expect(res.data.moved.listings).toBe(1);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .categoryId,
      ).toBe(to.id);
    });

    it('two concurrent transfers of the same category move each row once', async () => {
      const from = await category('from');
      const to = await category('to');
      const other = await category('other');
      await part('p', from.id);

      const results = await Promise.allSettled([
        transfers.transfer(from.id, {
          targetCategoryId: to.id,
          reason: REASON,
        }),
        transfers.transfer(from.id, {
          targetCategoryId: other.id,
          reason: REASON,
        }),
      ]);

      const moved = results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => r.value.data.moved.parts);
      expect(moved.reduce((a, b) => a + b, 0)).toBe(1);
      expect(
        await prisma.catalogPart.count({ where: { categoryId: from.id } }),
      ).toBe(0);
    });

    it('a transfer and a delete of the same source never lose a row', async () => {
      const from = await category('from');
      const to = await category('to');
      const p = await part('p', from.id);

      await Promise.allSettled([
        transfers.transfer(from.id, {
          targetCategoryId: to.id,
          reason: REASON,
        }),
        categories.remove(from.id),
      ]);

      const after = await prisma.catalogPart.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(after.categoryId).toBe(to.id);
    });
  });
});
