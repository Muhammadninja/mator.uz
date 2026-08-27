// Tests for CatalogProjectionService — the single authoritative Product/Stock →
// CatalogPart mapping. These pin the mapping rules (deterministic ids, seller
// name fallback, single-vs-multi brand selection, part-data shape, uncategorized
// fallback) so both the Telegram live path and the backfill stay identical.
//
// DB-independent: we drive the shared Prisma mock and inspect the upsert args
// the service builds.

import { PartCondition } from '@prisma/client';
import { CatalogProjectionService } from './catalog-projection.service';
import { createPrismaMock, PrismaMock } from '../../../test/utils/harness';

type StockRow = Parameters<CatalogProjectionService['buildProjectionOps']>[0];

function buildStock(over: Partial<any> = {}): StockRow {
  return {
    id: 500,
    sellerId: 7,
    productId: 100,
    priceUzs: 185000,
    quantity: 3,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    seller: {
      id: 7,
      storeName: 'Avtomir',
      marketName: 'Chorsu',
      ...(over.seller ?? {}),
    },
    product: {
      id: 100,
      gmNumber: '96535062',
      oemNumber: null,
      partNumberType: 'UNKNOWN',
      title: 'Timing belt',
      description: null,
      imageUrl: null,
      isUniversal: false,
      mainCategory: 'BELTS_AND_HOSES',
      vehicleCategory: 'ENGINE',
      partBrand: 'Chevrolet',
      originRegion: 'USA',
      isOem: true,
      isGm: true,
      kind: 'SPARE_PART',
      oilViscosity: null,
      oilType: null,
      oilVolumeMl: null,
      // Curated rating (admin-maintained), projected verbatim like every other
      // Product attribute. Unrated by default; the rating tests override these.
      ratingAvg: null,
      reviewCount: 0,
      images: [
        { url: 'https://cdn/img0.webp', sortOrder: 0 },
        { url: 'https://cdn/img1.webp', sortOrder: 1 },
      ],
      partModels: [
        { model: { name: 'Cobalt', brand: { id: 2, name: 'Chevrolet' } } },
      ],
      ...(over.product ?? {}),
    },
    ...over,
  } as unknown as StockRow;
}

// Pull the recorded upsert args for a given delegate/model out of the mock.
function upsertArg(prisma: PrismaMock, model: string) {
  return prisma[model].upsert.mock.calls.at(-1)?.[0];
}

describe('CatalogProjectionService — mapping', () => {
  let prisma: PrismaMock;
  let svc: CatalogProjectionService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new CatalogProjectionService(prisma as any);
  });

  describe('deterministic ids', () => {
    it('derives buyer ids from supply-side integer PKs', () => {
      expect(CatalogProjectionService.catalogSellerId(7)).toBe('seller_7');
      expect(CatalogProjectionService.partBrandId(2)).toBe('brand_2');
      expect(CatalogProjectionService.catalogPartId(500)).toBe('part_stock_500');
    });
  });

  describe('buildProjectionOps', () => {
    it('maps a single-brand listing to the expected CatalogPart shape', () => {
      svc.buildProjectionOps(buildStock());

      const part = upsertArg(prisma, 'catalogPart');
      expect(part.where).toEqual({ id: 'part_stock_500' });
      expect(part.create).toMatchObject({
        id: 'part_stock_500',
        title: 'Timing belt',
        brandId: 'brand_2', // exactly one linked vehicle brand → used
        // Bot-assigned mainCategory maps to its canonical PartCategory slug.
        categoryId: 'belts-and-hoses',
        sellerId: 'seller_7',
        // Unlabeled (UNKNOWN) number → searchable as BOTH GM and OEM.
        oemNumbers: ['96535062'],
        gmNumbers: ['96535062'],
        partNumberType: 'UNKNOWN',
        priceUzs: 185000,
        condition: PartCondition.NEW,
        inStock: true, // quantity 3 > 0
        images: ['https://cdn/img0.webp', 'https://cdn/img1.webp'],
      });
      // update carries the same data (idempotent upsert).
      expect(part.update).toMatchObject({ priceUzs: 185000, inStock: true });
    });

    it('projects the SELLER-CHOSEN categoryId in preference to the enum', () => {
      // The seller's explicit pick from the dynamic tree is authoritative. A
      // legacy enum that disagrees (e.g. the admin re-parented the category
      // after the classifier ran) must not win.
      const base = buildStock() as any;
      svc.buildProjectionOps({
        ...base,
        product: {
          ...base.product,
          mainCategory: 'BRAKES',
          categoryId: 'brake-pads',
        },
      });
      const part = upsertArg(prisma, 'catalogPart').create;
      expect(part.categoryId).toBe('brake-pads');
    });

    it('projects an admin-created "Другое" category that mirrors NO enum', () => {
      // The regression this guards: an OTHER-child oil has mainCategory = null,
      // so deriving from the enum alone buried it in the fallback bucket and the
      // buyer could never reach it with ?category=motorcycle-oil.
      const base = buildStock() as any;
      svc.buildProjectionOps({
        ...base,
        product: {
          ...base.product,
          kind: 'MOTOR_OIL',
          mainCategory: null,
          vehicleCategory: null,
          categoryId: 'motorcycle-oil',
          isUniversal: true,
        },
      });
      const part = upsertArg(prisma, 'catalogPart').create;
      expect(part.categoryId).toBe('motorcycle-oil');
      expect(part.categoryId).not.toBe(
        CatalogProjectionService.UNCATEGORIZED_ID,
      );
      // Universality is projected verbatim from the listing.
      expect(part.isUniversal).toBe(true);
    });

    it('falls back to the uncategorized bucket for an unclassified product', () => {
      const base = buildStock() as any;
      svc.buildProjectionOps({
        ...base,
        product: { ...base.product, mainCategory: null },
      });
      const part = upsertArg(prisma, 'catalogPart').create;
      // CatalogPart.categoryId is NOT NULL, so a product the bot never
      // classified still needs a category to point at.
      expect(part.categoryId).toBe(CatalogProjectionService.UNCATEGORIZED_ID);
    });

    it('projects the classified attributes verbatim from the Product', () => {
      svc.buildProjectionOps(buildStock());
      const part = upsertArg(prisma, 'catalogPart').create;
      expect(part).toMatchObject({
        mainCategory: 'BELTS_AND_HOSES',
        vehicleCategory: 'ENGINE',
        partBrandName: 'Chevrolet',
        originRegion: 'USA',
        isOem: true,
        isGm: true,
        isUniversal: false,
      });
    });

    it('replaces fit rows and denormalizes make/model with contract slugs', () => {
      svc.buildProjectionOps(buildStock());
      // Old rows cleared for idempotency…
      expect(prisma.catalogPartFit.deleteMany).toHaveBeenCalledWith({ where: { partId: 'part_stock_500' } });
      // …then the new fit rows created.
      const createArg = prisma.catalogPartFit.createMany.mock.calls.at(-1)?.[0];
      expect(createArg.data).toEqual([
        {
          partId: 'part_stock_500',
          makeSlug: 'make_chevrolet',
          modelSlug: 'model_chevrolet_cobalt',
          makeName: 'Chevrolet',
          modelName: 'Cobalt',
        },
      ]);
    });

    it('creates no fit rows for a universal (modelless) product', () => {
      svc.buildProjectionOps(
        buildStock({
          product: {
            id: 100,
            gmNumber: null,
            title: 'Universal clip',
            isUniversal: true,
            images: [],
            partModels: [],
          },
        }),
      );
      expect(prisma.catalogPartFit.createMany).not.toHaveBeenCalled();
    });

    it('ensures the uncategorized fallback category', () => {
      svc.buildProjectionOps(buildStock());
      const cat = upsertArg(prisma, 'partCategory');
      expect(cat.where).toEqual({ id: CatalogProjectionService.UNCATEGORIZED_ID });
      // The three localized names are NOT NULL, so the fallback bucket carries
      // its own translations rather than depending on a seed having run.
      expect(cat.create).toEqual({
        id: CatalogProjectionService.UNCATEGORIZED_ID,
        name: 'Uncategorized',
        nameRu: 'Без категории',
        nameUz: 'Turkumlanmagan',
        nameEn: 'Uncategorized',
      });
    });

    it('projects the parent seller, falling back through storeName → marketName → id', () => {
      svc.buildProjectionOps(buildStock());
      expect(upsertArg(prisma, 'catalogSeller').create).toEqual({
        id: 'seller_7',
        name: 'Avtomir',
        internalSellerId: 7,
      });

      prisma.catalogSeller.upsert.mockClear();
      svc.buildProjectionOps(buildStock({ seller: { id: 7, storeName: null, marketName: 'Chorsu' } }));
      expect(upsertArg(prisma, 'catalogSeller').create.name).toBe('Chorsu');

      prisma.catalogSeller.upsert.mockClear();
      svc.buildProjectionOps(buildStock({ seller: { id: 7, storeName: null, marketName: null } }));
      expect(upsertArg(prisma, 'catalogSeller').create.name).toBe('Seller 7');
    });

    it('leaves brandId null for a multi-brand listing', () => {
      svc.buildProjectionOps(
        buildStock({
          product: {
            id: 100,
            gmNumber: '96535062',
            title: 'Timing belt',
            isUniversal: false,
            images: [],
            partModels: [
              { model: { name: 'Cobalt', brand: { id: 2, name: 'Chevrolet' } } },
              { model: { name: 'Solaris', brand: { id: 5, name: 'Hyundai' } } },
            ],
          },
        }),
      );
      expect(upsertArg(prisma, 'catalogPart').create.brandId).toBeNull();
    });

    it('leaves brandId null and oemNumbers empty for a brandless, gm-less product', () => {
      svc.buildProjectionOps(
        buildStock({
          product: {
            id: 100,
            gmNumber: null,
            title: 'Universal clip',
            isUniversal: true,
            images: [],
            partModels: [],
          },
        }),
      );
      const part = upsertArg(prisma, 'catalogPart').create;
      expect(part.brandId).toBeNull();
      expect(part.oemNumbers).toEqual([]);
    });

    it('marks a zero-quantity listing out of stock', () => {
      svc.buildProjectionOps(buildStock({ quantity: 0 }));
      const part = upsertArg(prisma, 'catalogPart').create;
      expect(part.inStock).toBe(false);
    });

    it('projects the listing kind and a motor oil’s attributes verbatim', () => {
      // The buyer catalog must be able to render an oil card without joining
      // back to the supply domain, so these travel across the boundary as-is.
      svc.buildProjectionOps(
        buildStock({
          product: {
            ...buildStock().product,
            kind: 'MOTOR_OIL',
            title: 'Mobil 1 ESP 5W-30 4L',
            oilViscosity: '5W-30',
            oilType: 'SYNTHETIC',
            oilVolumeMl: 4000,
          },
        }),
      );
      const upsert = upsertArg(prisma, 'catalogPart');
      // Written on BOTH branches, so a re-projection converges.
      for (const data of [upsert.create, upsert.update]) {
        expect(data).toMatchObject({
          kind: 'MOTOR_OIL',
          oilViscosity: '5W-30',
          oilType: 'SYNTHETIC',
          oilVolumeMl: 4000,
        });
      }
    });

    it('projects a spare part as SPARE_PART with null oil attributes', () => {
      svc.buildProjectionOps(buildStock());
      const part = upsertArg(prisma, 'catalogPart').create;
      expect(part).toMatchObject({
        kind: 'SPARE_PART',
        oilViscosity: null,
        oilType: null,
        oilVolumeMl: null,
      });
    });
  });

  describe('curated rating', () => {
    it('projects ratingAvg and reviewCount verbatim from the Product', () => {
      const stock = buildStock();
      // Mutate the fully-built fixture: `buildStock`'s top-level `over` spread
      // REPLACES the whole `product` object, which would drop partModels/images.
      Object.assign((stock as any).product, { ratingAvg: 4.7, reviewCount: 123 });
      svc.buildProjectionOps(stock);
      const upsert = upsertArg(prisma, 'catalogPart');
      // Present on BOTH branches: a first projection creates the row, a later
      // one updates it, and a rating edit must reach an existing row too.
      expect(upsert.create).toMatchObject({ ratingAvg: 4.7, reviewCount: 123 });
      expect(upsert.update).toMatchObject({ ratingAvg: 4.7, reviewCount: 123 });
    });

    it('projects an unrated product as null / 0 rather than a fabricated value', () => {
      svc.buildProjectionOps(buildStock());
      const part = upsertArg(prisma, 'catalogPart').create;
      expect(part.ratingAvg).toBeNull();
      expect(part.reviewCount).toBe(0);
    });
  });

  describe('projectProduct', () => {
    it('re-projects EVERY stock of the product, so a rating edit fans out', async () => {
      prisma.stock.findMany.mockResolvedValue([{ id: 500 }, { id: 501 }]);
      prisma.stock.findUnique
        .mockResolvedValueOnce(buildStock({ id: 500 }))
        .mockResolvedValueOnce(buildStock({ id: 501 }));

      const ids = await svc.projectProduct(100);

      expect(ids).toEqual(['part_stock_500', 'part_stock_501']);
    });

    it('is a no-op for a product no seller lists', async () => {
      prisma.stock.findMany.mockResolvedValue([]);
      expect(await svc.projectProduct(100)).toEqual([]);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('projectStock / deleteProjection', () => {
    it('loads the stock, runs the ops in a transaction, and returns the part id', async () => {
      prisma.stock.findUnique.mockResolvedValue(buildStock());
      const id = await svc.projectStock(500);
      expect(id).toBe('part_stock_500');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('no-ops (returns null) when the stock is gone', async () => {
      prisma.stock.findUnique.mockResolvedValue(null);
      const id = await svc.projectStock(999);
      expect(id).toBeNull();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('deleteProjection removes the CatalogPart by deterministic id', async () => {
      await svc.deleteProjection(500);
      expect(prisma.catalogPart.deleteMany).toHaveBeenCalledWith({ where: { id: 'part_stock_500' } });
    });

    it('updateProjection is an alias for projectStock', async () => {
      prisma.stock.findUnique.mockResolvedValue(buildStock());
      expect(await svc.updateProjection(500)).toBe('part_stock_500');
    });
  });
});

describe('CatalogProjectionService.numberSearchArrays', () => {
  const { numberSearchArrays } = CatalogProjectionService;

  it('GM-labeled → searchable only as GM', () => {
    expect(numberSearchArrays('96535062', null, 'GM' as any)).toEqual({
      gmNumbers: ['96535062'],
      oemNumbers: [],
    });
  });

  it('OEM-labeled → searchable only as OEM', () => {
    expect(numberSearchArrays(null, '96535062', 'OEM' as any)).toEqual({
      gmNumbers: [],
      oemNumbers: ['96535062'],
    });
  });

  it('UNKNOWN (unlabeled) → searchable as BOTH', () => {
    expect(numberSearchArrays('96535062', null, 'UNKNOWN' as any)).toEqual({
      gmNumbers: ['96535062'],
      oemNumbers: ['96535062'],
    });
  });

  it('excludes synthetic idempotency keys (tg_…) from both arrays', () => {
    expect(numberSearchArrays('tg_123_456', null, 'UNKNOWN' as any)).toEqual({
      gmNumbers: [],
      oemNumbers: [],
    });
  });

  it('yields empty arrays when there is no number', () => {
    expect(numberSearchArrays(null, null, 'UNKNOWN' as any)).toEqual({
      gmNumbers: [],
      oemNumbers: [],
    });
  });
});
