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
        categoryId: CatalogProjectionService.UNCATEGORIZED_ID,
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
      expect(cat.create).toEqual({ id: CatalogProjectionService.UNCATEGORIZED_ID, name: 'Uncategorized' });
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
