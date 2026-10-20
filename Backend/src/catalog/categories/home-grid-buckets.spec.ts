// The home grid end to end over 1C-style data: products filed on category-tree
// nodes and (mostly) never bucketed are projected exactly as production does
// (CatalogProjectionService.classificationOf), then every tile's count from
// GET /v1/categories is compared with what tapping it lists
// (GET /v1/catalog/parts?category=<tile id>). Both run their real predicates
// over the same rows (where-eval), so a count can never promise parts the
// listing then fails to show — and no tile may come back empty.

import { DealerStatus, PartMainCategory as B } from '@prisma/client';
import { CategoriesService } from './categories.service';
import { MAIN_CATEGORIES } from './part-categories.catalog';
import { PartsService } from '../parts/parts.service';
import { CatalogProjectionService } from '../projection/catalog-projection.service';
import { matchesWhere } from '../compatibility/where-eval.test-util';
import { LIVE_PARENTS } from './seeded-category-tree.test-util';

interface SupplyProduct {
  id: string;
  categoryId: string | null;
  mainCategory: B | null;
  photo?: false;
  suspended?: true;
}

const SUPPLY: SupplyProduct[] = [
  { id: 'p01', categoryId: 'front-brake-pads', mainCategory: null },
  { id: 'p02', categoryId: 'front-brake-pads', mainCategory: null },
  { id: 'p03', categoryId: 'rear-brake-pads', mainCategory: null },
  { id: 'p04', categoryId: 'shock-absorbers', mainCategory: null },
  { id: 'p05', categoryId: 'air-filters', mainCategory: null },
  { id: 'p06', categoryId: 'air-filters', mainCategory: null },
  { id: 'p07', categoryId: 'cabin-filters', mainCategory: null },
  { id: 'p08', categoryId: 'antifreeze', mainCategory: null },
  { id: 'p09', categoryId: 'synthetic-motor-oil', mainCategory: null },
  { id: 'p10', categoryId: 'spark-plugs', mainCategory: null },
  { id: 'p11', categoryId: 'tire-pressure-sensors', mainCategory: null },
  { id: 'p12', categoryId: 'headlights-and-bulbs', mainCategory: null },
  { id: 'p13', categoryId: 'timing-belt-kits', mainCategory: null },
  { id: 'p14', categoryId: 'gaskets-and-seals', mainCategory: null },
  { id: 'p15', categoryId: 'wiper-blades', mainCategory: null },
  { id: 'p16', categoryId: 'skid-plates', mainCategory: null },
  // Filed on a bucket row itself.
  { id: 'p17', categoryId: 'batteries', mainCategory: null },
  // An assigned bucket wins over the tree: counted under ENGINE, not FILTERS.
  { id: 'p18', categoryId: 'air-filters', mainCategory: B.ENGINE },
  // No home bucket: on no tile, still reachable by their own category.
  { id: 'p19', categoryId: 'clutch-kits', mainCategory: null },
  { id: 'p20', categoryId: 'cooling-radiators', mainCategory: null },
  { id: 'p21', categoryId: null, mainCategory: null },
  // Not buyer-listed: neither counted nor listed anywhere.
  { id: 'p22', categoryId: 'air-filters', mainCategory: null, photo: false },
  {
    id: 'p23',
    categoryId: 'front-brake-pads',
    mainCategory: null,
    suspended: true,
  },
];

/** Independent oracle: the approved leaf → bucket table applied by hand. */
const EXPECTED_TILE_COUNTS: Record<string, number> = {
  brakes: 3,
  batteries: 1,
  filters: 3,
  ignition: 1,
  engine: 2,
  'electrical-parts': 1,
  'oil-and-fluids': 2,
  'belts-and-hoses': 1,
  wipers: 1,
  lighting: 1,
  suspension: 1,
  exterior: 1,
};

/** The catalog_parts rows the projection writes for SUPPLY. */
const PARTS = SUPPLY.map((p) => ({
  id: p.id,
  ...CatalogProjectionService.classificationOf(
    {
      categoryId: p.categoryId,
      mainCategory: p.mainCategory,
      vehicleCategory: null,
    },
    LIVE_PARENTS,
  ),
  images: p.photo === false ? [] : [`https://cdn/${p.id}.webp`],
  seller: {
    status: p.suspended ? DealerStatus.SUSPENDED : DealerStatus.ACTIVE,
  },
}));

/** The 12 home-grid rows, as categories.service.ts selects them. */
const GRID_ROWS = MAIN_CATEGORIES.map((c) => ({
  id: c.slug,
  name: c.name,
  nameRu: c.name,
  nameUz: c.name,
  nameEn: c.name,
  slug: c.slug,
  iconKey: c.iconKey,
  color: c.color,
  mainCategory: c.id,
}));

const NO_DISCOUNTS = {
  loadActiveSales: jest.fn().mockResolvedValue([]),
  calculateDiscount: (price: number) => ({
    originalPrice: price,
    finalPrice: price,
    discountAmount: 0,
    discountPercent: 0,
    appliedSale: null,
  }),
};

/**
 * A Prisma double for exactly the calls both services make, whose counts and
 * groupings run the real `where` over PARTS. The listing's rows, brand facet
 * and subcategory chips come back empty — only the totals are compared.
 */
function catalogDb() {
  const selected = (where: unknown) =>
    PARTS.filter((p) => matchesWhere(p, where));
  return {
    partCategory: { findMany: jest.fn().mockResolvedValue(GRID_ROWS) },
    catalogPart: {
      count: jest.fn(({ where }: { where: unknown }) =>
        Promise.resolve(selected(where).length),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn(({ by, where }: { by: string[]; where: unknown }) => {
        if (by.length !== 1 || by[0] !== 'mainCategory') {
          return Promise.resolve([]);
        }
        const counts = new Map<B | null, number>();
        for (const p of selected(where)) {
          counts.set(p.mainCategory, (counts.get(p.mainCategory) ?? 0) + 1);
        }
        return Promise.resolve(
          [...counts].map(([mainCategory, n]) => ({
            mainCategory,
            _count: { _all: n },
          })),
        );
      }),
      aggregate: jest.fn().mockResolvedValue({
        _min: { priceUzs: null },
        _max: { priceUzs: null },
      }),
    },
    partBrand: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}

describe('home grid — tile counts match their listings', () => {
  let grid: { id: string; count: number }[];
  let parts: PartsService;

  beforeAll(async () => {
    const prisma = catalogDb();
    grid = (await new CategoriesService(prisma as never).list({}, 'ru', null))
      .items;
    parts = new PartsService(prisma as never, NO_DISCOUNTS as never);
  });

  it('serves the 12 tiles in their designed order', () => {
    expect(grid.map((t) => t.id)).toEqual(MAIN_CATEGORIES.map((c) => c.slug));
  });

  it('every tile counts exactly what tapping it lists — and none is empty', async () => {
    for (const tile of grid) {
      const listing = await parts.list({ category: tile.id }, 'ru', null);
      expect({
        tile: tile.id,
        count: tile.count,
        listed: listing.total,
      }).toEqual({
        tile: tile.id,
        count: EXPECTED_TILE_COUNTS[tile.id],
        listed: EXPECTED_TILE_COUNTS[tile.id],
      });
    }
  });

  it('counts every listed bucketed part once, and parts without a bucket on no tile', async () => {
    const onTiles = grid.reduce((n, t) => n + t.count, 0);
    const listed = (await parts.list({}, 'ru', null)).total;
    expect(listed).toBe(SUPPLY.length - 2); // no photo, suspended dealer
    expect(onTiles).toBe(listed - 3); // clutch-kits, cooling-radiators, none
  });

  it('a part without a home bucket stays reachable by its own category', async () => {
    expect(
      (await parts.list({ category: 'clutch-kits' }, 'ru', null)).total,
    ).toBe(1);
    expect(
      (await parts.list({ category: 'cooling-radiators' }, 'ru', null)).total,
    ).toBe(1);
  });
});
