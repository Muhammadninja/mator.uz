import { SearchService } from '../../src/catalog/search/search.service';
import { PartsService } from '../../src/catalog/parts/parts.service';
import { CategoriesService } from '../../src/catalog/categories/categories.service';
import { createPrismaMock, fakeDiscounts, PrismaMock } from '../utils/harness';
import {
  isTreeEdgeRead,
  LIVE_TREE,
  partCategoryFindMany,
} from '../../src/catalog/categories/seeded-category-tree.test-util';
import { categoryTreeScope } from '../../src/catalog/categories/category-tree-scope';

/** Buckets and systems come from the live tree: the production-shaped one. */
const TREE = categoryTreeScope(LIVE_TREE);

function buildPart(over: Partial<any> = {}): any {
  return {
    id: 'part_belt',
    title: 'Timing belt',
    gmNumbers: [],
    // The presenter reads the kind's capability table (part numbers, fitment),
    // so a row without it resolves `capabilitiesOf(undefined)` to undefined.
    // SPARE_PART is the column's schema default.
    kind: 'SPARE_PART',
    brand: { id: 'brand_gates', name: 'Gates' },
    category: { id: 'cat_belts', name: 'Timing belts' },
    seller: { id: 'seller_1', name: 'Avtomir', ratingAvg: 4.6 },
    compatibilities: [],
    fits: [],
    oemNumbers: ['0816A6'],
    priceUzs: 185000,
    currency: 'UZS',
    inStock: true,
    stockQty: 12,
    deliveryEtaDaysMin: 1,
    deliveryEtaDaysMax: 3,
    images: ['https://img/belt.png'],
    ...over,
  };
}

describe('Catalog/Search smoke', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  it('search returns formatted results and facet counts', async () => {
    const svc = new SearchService(prisma, fakeDiscounts());
    prisma.catalogPart.count
      .mockResolvedValueOnce(2) // total
      .mockResolvedValueOnce(1) // under 200k
      .mockResolvedValueOnce(1) // 200k–500k
      .mockResolvedValueOnce(0); // 4★+
    prisma.catalogPart.findMany.mockResolvedValue([
      {
        id: 'part_belt',
        title: 'Timing belt',
        priceUzs: 185000,
        categoryId: 'cat_belts',
        category: {
          id: 'cat_belts',
          name: 'Timing belts',
          nameRu: 'Ремни ГРМ',
          nameUz: 'GRM tasmalari',
          nameEn: 'Timing belts',
        },
      },
    ]);
    prisma.catalogPart.groupBy.mockResolvedValue([{ categoryId: 'cat_belts', _count: { _all: 2 } }]);
    prisma.partCategory.findMany.mockResolvedValue([
      {
        id: 'cat_belts',
        name: 'Timing belts',
        nameRu: 'Ремни ГРМ',
        nameUz: 'GRM tasmalari',
        nameEn: 'Timing belts',
      },
    ]);

    // No language given → the platform default (ru), so the facet is keyed by
    // the RUSSIAN label rather than the internal English one.
    const res = await svc.search({ query: 'belt' } as any);

    expect(res.total).toBe(2);
    expect(res.results[0].price).toBe('UZS 185 000');
    expect(res.facetCounts.categories['Ремни ГРМ']).toBe(2);
  });

  it('typeahead suggests the query plus matching products', async () => {
    const svc = new SearchService(prisma, fakeDiscounts());
    prisma.catalogPart.findMany.mockResolvedValue([{ id: 'part_belt', title: 'Timing belt' }]);
    const res = await svc.typeahead('belt');
    expect(res.suggestions[0]).toEqual({ text: 'belt', type: 'query' });
    expect(res.suggestions).toContainEqual(
      expect.objectContaining({ type: 'product', deeplink: expect.stringContaining('part_belt') }),
    );
  });

  it('parts list maps the contract item shape with price label', async () => {
    const svc = new PartsService(prisma, fakeDiscounts());
    prisma.catalogPart.count.mockResolvedValue(1);
    prisma.catalogPart.findMany.mockResolvedValue([buildPart()]);
    prisma.catalogPart.groupBy.mockResolvedValue([{ brandId: 'brand_gates', _count: { _all: 1 } }]);
    prisma.catalogPart.aggregate.mockResolvedValue({ _min: { priceUzs: 185000 }, _max: { priceUzs: 185000 } });
    prisma.partBrand.findMany.mockResolvedValue([{ id: 'brand_gates', name: 'Gates' }]);

    const res = await svc.list({} as any);

    expect(res.total).toBe(1);
    expect(res.items[0].price_label).toBe('UZS 185 000');
    expect(res.items[0].seller).toEqual({ id: 'seller_1', name: 'Avtomir', rating_avg: 4.6 });
    expect(res.facets.brands).toEqual([{ id: 'brand_gates', name: 'Gates', count: 1 }]);
  });

  it('compatibility projects a trim+year match as "fits"', async () => {
    const svc = new PartsService(prisma, fakeDiscounts());
    prisma.catalogPart.findFirst.mockResolvedValue({
      compatibilities: [
        { trimId: 'trim_lt', engineId: null, years: [2022], status: 'FITS', confidence: 1, source: 'oem' },
      ],
    });
    prisma.vehicle.findFirst.mockResolvedValue({ trimId: 'trim_lt', engineId: null, year: 2022 });

    const res = await svc.compatibility('part_belt', 'veh_1', 'usr_1');
    expect(res.status).toBe('fits');
    expect(res.matched_trims).toEqual([{ trim_id: 'trim_lt', years: [2022] }]);
  });

  it('presents the classified attributes in the item shape', async () => {
    const svc = new PartsService(prisma, fakeDiscounts());
    prisma.partCategory.findMany.mockImplementation(partCategoryFindMany());
    prisma.catalogPart.count.mockResolvedValue(1);
    prisma.catalogPart.findMany.mockResolvedValue([
      buildPart({
        // Bucket and system are read off the tree for the part's category,
        // never off the stored copies (left empty here on purpose).
        categoryId: 'timing-belt-kits',
        mainCategory: null,
        vehicleCategory: null,
        partBrandName: 'Chevrolet',
        originRegion: 'CHINA',
        isOem: true,
        isGm: true,
        isUniversal: false,
      }),
    ]);
    prisma.catalogPart.groupBy.mockResolvedValue([]);
    prisma.catalogPart.aggregate.mockResolvedValue({ _min: { priceUzs: 0 }, _max: { priceUzs: 0 } });
    prisma.partBrand.findMany.mockResolvedValue([]);

    const res = await svc.list({} as any);
    expect(res.items[0]).toMatchObject({
      main_category: 'BELTS_AND_HOSES',
      vehicle_category: 'ENGINE',
      origin_region: 'CHINA',
      is_oem: true,
      is_gm: true,
    });
  });

  // Capture the `where` the service builds so we can assert the server-side filters.
  async function whereForQuery(query: any, userId: string | null = null) {
    const svc = new PartsService(prisma, fakeDiscounts());
    prisma.partCategory.findMany.mockImplementation(partCategoryFindMany());
    prisma.catalogPart.count.mockResolvedValue(0);
    prisma.catalogPart.findMany.mockResolvedValue([]);
    prisma.catalogPart.groupBy.mockResolvedValue([]);
    prisma.catalogPart.aggregate.mockResolvedValue({ _min: { priceUzs: 0 }, _max: { priceUzs: 0 } });
    prisma.partBrand.findMany.mockResolvedValue([]);
    await svc.list(query, 'ru', userId);
    return prisma.catalogPart.findMany.mock.calls[0][0].where;
  }

  it('filters by main category through the tree, never the stored column', async () => {
    const where = await whereForQuery({ category: 'brakes' });
    expect(where.AND).toContainEqual({
      categoryId: { in: TREE.idsInMainCategory('BRAKES') },
    });
    expect(JSON.stringify(where)).not.toContain('mainCategory');
  });

  it('filters by make via curated bindings, fit rows OR universal (independent of garage)', async () => {
    const where = await whereForQuery({ make: 'Chevrolet' });
    const makeClause = where.AND.find((c: any) =>
      c.OR?.some((o: any) => o.fitmentBindings),
    );
    expect(makeClause.OR).toContainEqual({ isUniversal: true });
    expect(JSON.stringify(makeClause)).toContain('Chevrolet');
    // Legacy fit rows only decide for parts that carry no curated binding.
    expect(JSON.stringify(makeClause)).toContain(
      '{"fitmentBindings":{"none":{}}}',
    );
  });

  it('filters by region, gm_only and oem_only', async () => {
    const where = await whereForQuery({ region: ['china', 'korea'], gm_only: 'true', oem_only: 'true' });
    expect(where.AND).toContainEqual({ originRegion: { in: ['CHINA', 'KOREA'] } });
    expect(where.AND).toContainEqual({ isGm: true });
    expect(where.AND).toContainEqual({ isOem: true });
  });

  it('garage vehicle restricts to compatible parts (universal OR make/model OR trim)', async () => {
    prisma.vehicle.findFirst.mockResolvedValue({
      trimId: 'trim_lt',
      engineId: null,
      year: 2019,
      make: { name: 'Chevrolet' },
      model: { name: 'Cobalt' },
    });
    const where = await whereForQuery({ vehicle_id: 'veh_1' }, 'usr_1');
    const vClause = where.AND.find((c: any) => Array.isArray(c.OR));
    expect(vClause.OR).toContainEqual({ isUniversal: true });
    expect(JSON.stringify(vClause)).toContain('Cobalt');
    expect(JSON.stringify(vClause)).toContain('trim_lt');
  });
});

describe('Catalog/Categories smoke', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  it('main scope returns the active PartCategory rows with live counts, unmatched → 0', async () => {
    // Main scope is served from the admin-editable PartCategory table (the
    // single source of truth), NOT the hardcoded MAIN_CATEGORIES: the rows come
    // from `partCategory.findMany`. Counts group by `categoryId` and each
    // category rolls up to its bucket through the live tree, so a part filed on
    // a SUBCATEGORY still lands in its bucket — see the rollup case below. The
    // wire shape (id, name, slug, count, iconKey, color) is unchanged.
    const svc = new CategoriesService(prisma);
    const rows = [
      { id: 'brakes', name: 'Brakes', slug: 'brakes', iconKey: 'brake', color: '#f00', mainCategory: 'BRAKES' },
      { id: 'engine', name: 'Engine', slug: 'engine', iconKey: 'engine', color: '#0f0', mainCategory: 'ENGINE' },
      { id: 'batteries', name: 'Batteries', slug: 'batteries', iconKey: 'bat', color: '#00f', mainCategory: 'BATTERIES' },
    ];
    prisma.partCategory.findMany.mockImplementation(
      partCategoryFindMany(LIVE_TREE, () => rows),
    );
    // Keyed by category_id — what `groupBy: ['categoryId']` returns.
    prisma.catalogPart.groupBy.mockResolvedValue([
      { categoryId: 'brakes', _count: { _all: 12 } },
      { categoryId: 'gaskets-and-seals', _count: { _all: 25 } },
    ]);

    const res = await svc.list({});
    // Only ACTIVE rows that carry a mainCategory are listed.
    const rowsRead = prisma.partCategory.findMany.mock.calls
      .map((c: any[]) => c[0])
      .find((a: unknown) => !isTreeEdgeRead(a));
    expect(rowsRead.where).toEqual({
      isActive: true,
      mainCategory: { not: null },
    });
    // The grouping key is the category FK; the stored enum is never read.
    expect(prisma.catalogPart.groupBy.mock.calls[0][0].by).toEqual([
      'categoryId',
    ]);
    expect(res.total).toBe(rows.length);
    expect(res.items).toHaveLength(rows.length);
    const brakes = res.items.find((c) => c.id === 'brakes')!;
    expect(brakes).toMatchObject({ name: 'Brakes', slug: 'brakes', count: 12 });
    const engine = res.items.find((c) => c.id === 'engine')!;
    expect(engine.count).toBe(25);
    const batteries = res.items.find((c) => c.id === 'batteries')!;
    expect(batteries.count).toBe(0); // unmatched category → 0
  });

  // A part filed on a subcategory ('oil-filters') must be counted in the
  // Filters bucket on the home grid: the tree, not a stored enum, says so.
  it('main scope rolls subcategory-filed parts up into their bucket', async () => {
    const svc = new CategoriesService(prisma);
    prisma.partCategory.findMany.mockImplementation(
      partCategoryFindMany(LIVE_TREE, () => [
        { id: 'filters', name: 'Filters', slug: 'filters', iconKey: 'f', color: '#00f', mainCategory: 'FILTERS' },
      ]),
    );
    // No part is filed on the bucket row 'filters' itself; the 7 parts sit on
    // its subcategories and reach the bucket through the tree.
    prisma.catalogPart.groupBy.mockResolvedValue([
      { categoryId: 'oil-filters', _count: { _all: 4 } },
      { categoryId: 'air-filters', _count: { _all: 3 } },
    ]);

    const res = await svc.list({});
    expect(res.items.find((c) => c.id === 'filters')!.count).toBe(7);
  });

  it('vehicle scope returns the 8 vehicle-specific categories', async () => {
    const svc = new CategoriesService(prisma);
    prisma.partCategory.findMany.mockImplementation(partCategoryFindMany());
    prisma.catalogPart.groupBy.mockResolvedValue([
      { categoryId: 'front-brake-pads', _count: { _all: 3 } },
      { categoryId: 'brakes', _count: { _all: 1 } },
    ]);

    const res = await svc.list({ scope: 'vehicle' });
    expect(res.total).toBe(8);
    expect(res.items.find((c) => c.id === 'BRAKE_SYSTEM')!.count).toBe(4);
  });

  it('scopes counts to a garage vehicle (universal OR fitting make/model)', async () => {
    const svc = new CategoriesService(prisma);
    prisma.vehicle.findFirst.mockResolvedValue({ make: { name: 'Chevrolet' }, model: { name: 'Cobalt' } });
    prisma.catalogPart.groupBy.mockResolvedValue([]);

    await svc.list({ vehicle_id: 'veh_1' }, 'ru', 'usr_1');
    const where = prisma.catalogPart.groupBy.mock.calls[0][0].where;
    // [buyer-visible (no suspended dealer), the garage vehicle's fit clause]
    const [visible, vehicleClause] = where.AND;
    expect(visible).toEqual({
      seller: { status: { not: 'SUSPENDED' } },
      images: { isEmpty: false },
      NOT: { priceUzs: { lte: 0 } },
    });
    expect(vehicleClause.OR).toContainEqual({ isUniversal: true });
    expect(JSON.stringify(where)).toContain('Cobalt');
  });
});

// `vehicle_id` resolves ONLY within the authenticated caller's own garage. The
// double answers like the database would: the vehicle row comes back only for a
// lookup scoped to its live (not soft-deleted) owner.
describe('Catalog — vehicle_id resolves only in the caller garage', () => {
  const OWNER = 'usr_owner';
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.vehicle.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.userId === OWNER && where.deletedAt === null
          ? {
              modelId: 'cobalt',
              trimId: null,
              engineId: null,
              year: 2022,
              make: { name: 'Chevrolet' },
              model: { name: 'Cobalt' },
            }
          : null,
      ),
    );
    // A part the operator curated to the Cobalt.
    prisma.catalogPart.findFirst.mockResolvedValue(
      buildPart({
        isUniversal: false,
        fitmentBindings: [
          {
            vehicleModelId: 'cobalt',
            vehicleModel: { name: 'Cobalt', make: { name: 'Chevrolet' } },
          },
        ],
      }),
    );
  });

  it('part detail: the owner gets the verdict for their own car', async () => {
    const svc = new PartsService(prisma, fakeDiscounts());
    const res = await svc.detail('part_belt', 'veh_1', 'ru', OWNER);
    expect(res.compatibility).toMatchObject({ status: 'fits' });
  });

  it("part detail: another user's vehicle_id is treated as unknown (no verdict)", async () => {
    const svc = new PartsService(prisma, fakeDiscounts());
    const res = await svc.detail('part_belt', 'veh_1', 'ru', 'usr_other');
    expect(res.compatibility).toBeNull();
  });

  it('part detail: an anonymous caller never looks a vehicle up', async () => {
    const svc = new PartsService(prisma, fakeDiscounts());
    const res = await svc.detail('part_belt', 'veh_1', 'ru', null);
    expect(res.compatibility).toBeNull();
    expect(prisma.vehicle.findFirst).not.toHaveBeenCalled();
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
  });
});
