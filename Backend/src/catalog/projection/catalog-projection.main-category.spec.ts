// The home-grid bucket (mainCategory) CatalogProjectionService derives for a
// part filed on a category-tree node, through the real entry points: the live
// projection (projectStock) and the classification import
// (projectClassification), both reading the category tree from the database.

import { PartMainCategory as B, StockSourceSystem } from '@prisma/client';
import { CatalogProjectionService } from './catalog-projection.service';
import { PrismaService } from '../../prisma/prisma.service';
import { createPrismaMock } from '../../../test/utils/harness';
import {
  LIVE_TREE,
  SEEDED_TREE,
} from '../categories/seeded-category-tree.test-util';

type StockRow = Parameters<CatalogProjectionService['buildProjectionOps']>[0];

interface Listing {
  categoryId: string | null;
  mainCategory: B | null;
  /** Set for a Driver's Village 1C position; null for a Telegram listing. */
  sourceSystem?: StockSourceSystem | null;
}

function stockFor({ categoryId, mainCategory, sourceSystem }: Listing) {
  const imported = sourceSystem !== null;
  return {
    id: 500,
    sellerId: 7,
    productId: 100,
    priceUzs: 120000,
    quantity: 4,
    sourceSystem: imported ? StockSourceSystem.DRIVERS_VILLAGE_1C : null,
    seller: {
      id: 7,
      storeName: 'Drivers Village',
      marketName: null,
      catalogSellerId: imported ? 'drivers-village' : null,
    },
    product: {
      id: 100,
      gmNumber: null,
      oemNumber: null,
      gmNumbers: [],
      oemNumbers: [],
      partNumberType: 'UNKNOWN',
      title: 'Комплект передних тормозных колодок',
      isUniversal: false,
      categoryId,
      mainCategory,
      vehicleCategory: null,
      partBrand: null,
      originRegion: null,
      isOem: false,
      isGm: false,
      kind: 'SPARE_PART',
      oilViscosity: null,
      oilType: null,
      oilVolumeMl: null,
      antifreezeWeightG: null,
      packageForm: null,
      ratingAvg: null,
      reviewCount: 0,
      images: [{ url: 'https://cdn/pads.webp', sortOrder: 0 }],
      partModels: [],
      partMakes: [],
    },
  } as unknown as StockRow;
}

/** The catalog-part upsert argument these tests read back. */
interface PartUpsert {
  create: { categoryId: string; mainCategory: B | null };
  update: Record<string, unknown>;
}

/** The delegates these tests drive on the shared harness mock. */
interface ProjectionDb {
  partCategory: { findMany: jest.Mock };
  catalogSeller: { findUnique: jest.Mock };
  stock: { findUnique: jest.Mock };
  catalogPart: {
    upsert: jest.Mock<unknown, [PartUpsert]>;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
}

describe('CatalogProjectionService — mainCategory from the category tree', () => {
  let prisma: ProjectionDb;
  let svc: CatalogProjectionService;

  beforeEach(() => {
    const mock: unknown = createPrismaMock();
    prisma = mock as ProjectionDb;
    svc = new CatalogProjectionService(mock as PrismaService);
    prisma.partCategory.findMany.mockResolvedValue(LIVE_TREE);
    prisma.catalogSeller.findUnique.mockResolvedValue({
      id: 'drivers-village',
    });
  });

  /** The catalog-part upsert projectStock built for `listing`. */
  async function project(listing: Listing): Promise<PartUpsert> {
    prisma.stock.findUnique.mockResolvedValue(stockFor(listing));
    await svc.projectStock(500);
    const [upsert] = prisma.catalogPart.upsert.mock.calls.at(-1) ?? [];
    if (!upsert) throw new Error('projectStock wrote no catalog part');
    return upsert;
  }

  it.each([
    ['front-brake-pads', B.BRAKES],
    ['rear-brake-pads', B.BRAKES],
    ['shock-absorbers', B.SUSPENSION],
    ['air-filters', B.FILTERS],
    ['antifreeze', B.OIL_AND_FLUIDS],
    ['spark-plugs', B.IGNITION],
    ['tire-pressure-sensors', B.ELECTRICAL_PARTS],
    ['headlights-and-bulbs', B.LIGHTING],
    ['timing-belt-kits', B.BELTS_AND_HOSES],
    ['gaskets-and-seals', B.ENGINE],
    ['wiper-blades', B.WIPERS],
    ['skid-plates', B.EXTERIOR],
    ['semi-synthetic-motor-oil', B.OIL_AND_FLUIDS],
  ])(
    'an unbucketed 1C part on %s is projected into %s',
    async (categoryId, bucket) => {
      const { create } = await project({ categoryId, mainCategory: null });
      expect(create.categoryId).toBe(categoryId);
      expect(create.mainCategory).toBe(bucket);
    },
  );

  it.each([
    'clutch-kits',
    'cooling-radiators',
    'fuel-and-oil-pumps',
    'sealants',
  ])('a part on %s stays unbucketed', async (categoryId) => {
    const { create } = await project({ categoryId, mainCategory: null });
    expect(create.mainCategory).toBeNull();
  });

  it('a product filed on no category keeps the fallback category and no bucket', async () => {
    const { create } = await project({ categoryId: null, mainCategory: null });
    expect(create.categoryId).toBe(CatalogProjectionService.UNCATEGORIZED_ID);
    expect(create.mainCategory).toBeNull();
  });

  it('an assigned mainCategory is preserved, even where the tree disagrees', async () => {
    const { create } = await project({
      categoryId: 'air-filters',
      mainCategory: B.ENGINE,
    });
    expect(create.mainCategory).toBe(B.ENGINE);
  });

  it('a Telegram listing carries the derived bucket on update as well', async () => {
    const { create, update } = await project({
      categoryId: 'spark-plugs',
      mainCategory: null,
      sourceSystem: null,
    });
    expect(create.mainCategory).toBe(B.IGNITION);
    expect(update.mainCategory).toBe(B.IGNITION);
  });

  it('a re-projected 1C part keeps its stored classification (why existing rows need the backfill)', async () => {
    const { update } = await project({
      categoryId: 'front-brake-pads',
      mainCategory: null,
    });
    expect(update).not.toHaveProperty('mainCategory');
    expect(update).not.toHaveProperty('categoryId');
  });

  it('the classification import writes the derived bucket with its compare-and-set', async () => {
    prisma.stock.findUnique.mockResolvedValue(
      stockFor({ categoryId: 'front-brake-pads', mainCategory: null }),
    );
    prisma.catalogPart.findUnique.mockResolvedValue({ id: 'part_stock_500' });
    prisma.catalogPart.updateMany.mockResolvedValue({ count: 1 });

    await svc.projectClassification(500, {
      category: { expected: 'cat_uncategorized' },
    });

    expect(prisma.catalogPart.updateMany).toHaveBeenCalledWith({
      where: { id: 'part_stock_500', categoryId: 'cat_uncategorized' },
      data: {
        categoryId: 'front-brake-pads',
        mainCategory: B.BRAKES,
        vehicleCategory: null,
      },
    });
  });

  it('the seeded tree resolves the same way as production for seeded nodes', () => {
    const seeded = new Map(SEEDED_TREE.map((r) => [r.id, r.parentId]));
    for (const categoryId of [
      'front-brake-pads',
      'air-filters',
      'clutch-kits',
    ]) {
      const fromSeed = CatalogProjectionService.deriveMainCategory(
        null,
        categoryId,
        seeded,
      );
      const fromLive = CatalogProjectionService.deriveMainCategory(
        null,
        categoryId,
        new Map(LIVE_TREE.map((r) => [r.id, r.parentId])),
      );
      expect([categoryId, fromSeed]).toEqual([categoryId, fromLive]);
    }
  });
});
