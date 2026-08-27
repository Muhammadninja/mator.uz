import { SearchService } from '../../src/catalog/search/search.service';
import { PartsService } from '../../src/catalog/parts/parts.service';
import { CategoriesService } from '../../src/catalog/categories/categories.service';
import { createPrismaMock, fakeDiscounts, PrismaMock } from '../utils/harness';

function buildPart(over: Partial<any> = {}): any {
  return {
    id: 'part_belt',
    title: 'Timing belt',
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
    const svc = new SearchService(prisma);
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
    const svc = new SearchService(prisma);
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
    prisma.catalogPart.findUnique.mockResolvedValue({
      compatibilities: [
        { trimId: 'trim_lt', engineId: null, years: [2022], status: 'FITS', confidence: 1, source: 'oem' },
      ],
    });
    prisma.vehicle.findUnique.mockResolvedValue({ trimId: 'trim_lt', engineId: null, year: 2022 });

    const res = await svc.compatibility('part_belt', 'veh_1');
    expect(res.status).toBe('fits');
    expect(res.matched_trims).toEqual([{ trim_id: 'trim_lt', years: [2022] }]);
  });

  it('presents the classified attributes in the item shape', async () => {
    const svc = new PartsService(prisma, fakeDiscounts());
    prisma.catalogPart.count.mockResolvedValue(1);
    prisma.catalogPart.findMany.mockResolvedValue([
      buildPart({
        mainCategory: 'BELTS_AND_HOSES',
        vehicleCategory: 'ENGINE',
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
  async function whereForQuery(query: any) {
    const svc = new PartsService(prisma, fakeDiscounts());
    prisma.catalogPart.count.mockResolvedValue(0);
    prisma.catalogPart.findMany.mockResolvedValue([]);
    prisma.catalogPart.groupBy.mockResolvedValue([]);
    prisma.catalogPart.aggregate.mockResolvedValue({ _min: { priceUzs: 0 }, _max: { priceUzs: 0 } });
    prisma.partBrand.findMany.mockResolvedValue([]);
    await svc.list(query);
    return prisma.catalogPart.findMany.mock.calls[0][0].where;
  }

  it('filters by main category enum', async () => {
    const where = await whereForQuery({ category: 'brakes' });
    expect(where.AND).toContainEqual({ mainCategory: 'BRAKES' });
  });

  it('filters by make via fit rows OR universal (independent of garage)', async () => {
    const where = await whereForQuery({ make: 'Chevrolet' });
    const makeClause = where.AND.find((c: any) => c.OR?.some((o: any) => o.fits));
    expect(makeClause.OR).toContainEqual({ isUniversal: true });
    expect(JSON.stringify(makeClause)).toContain('Chevrolet');
  });

  it('filters by region, gm_only and oem_only', async () => {
    const where = await whereForQuery({ region: ['china', 'korea'], gm_only: 'true', oem_only: 'true' });
    expect(where.AND).toContainEqual({ originRegion: { in: ['CHINA', 'KOREA'] } });
    expect(where.AND).toContainEqual({ isGm: true });
    expect(where.AND).toContainEqual({ isOem: true });
  });

  it('garage vehicle restricts to compatible parts (universal OR make/model OR trim)', async () => {
    prisma.vehicle.findUnique.mockResolvedValue({
      trimId: 'trim_lt',
      engineId: null,
      year: 2019,
      make: { name: 'Chevrolet' },
      model: { name: 'Cobalt' },
    });
    const where = await whereForQuery({ vehicle_id: 'veh_1' });
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
    // from `partCategory.findMany`. Counts group by `mainCategory` (the ENUM),
    // not by `categoryId`, so that a part filed on a SUBCATEGORY still rolls up
    // into its bucket here — see the rollup case below. The wire shape
    // (id, name, slug, count, iconKey, color) is unchanged.
    const svc = new CategoriesService(prisma);
    const rows = [
      { id: 'brakes', name: 'Brakes', slug: 'brakes', iconKey: 'brake', color: '#f00', mainCategory: 'BRAKES' },
      { id: 'engine', name: 'Engine', slug: 'engine', iconKey: 'engine', color: '#0f0', mainCategory: 'ENGINE' },
      { id: 'batteries', name: 'Batteries', slug: 'batteries', iconKey: 'bat', color: '#00f', mainCategory: 'BATTERIES' },
    ];
    prisma.partCategory.findMany.mockResolvedValue(rows);
    // Keyed by the mainCategory ENUM — what `groupBy: ['mainCategory']` returns.
    prisma.catalogPart.groupBy.mockResolvedValue([
      { mainCategory: 'BRAKES', _count: { _all: 12 } },
      { mainCategory: 'ENGINE', _count: { _all: 25 } },
    ]);

    const res = await svc.list({});
    // Only ACTIVE rows that carry a mainCategory are listed.
    expect(prisma.partCategory.findMany.mock.calls[0][0].where).toEqual({
      isActive: true,
      mainCategory: { not: null },
    });
    // The grouping key is the enum column, not the category FK.
    expect(prisma.catalogPart.groupBy.mock.calls[0][0].by).toEqual([
      'mainCategory',
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

  // The REASON counts group by the enum rather than the category FK: a part
  // filed on a subcategory ('oil-filters') carries mainCategory FILTERS, so it
  // must still be counted in the Filters bucket on the home grid. Grouping by
  // categoryId would report 0 for the bucket row and drop the part entirely.
  it('main scope rolls subcategory-filed parts up into their bucket', async () => {
    const svc = new CategoriesService(prisma);
    prisma.partCategory.findMany.mockResolvedValue([
      { id: 'filters', name: 'Filters', slug: 'filters', iconKey: 'f', color: '#00f', mainCategory: 'FILTERS' },
    ]);
    // No part is filed on the bucket row 'filters' itself; the 7 parts sit on
    // its subcategories and reach the bucket via their mainCategory enum.
    prisma.catalogPart.groupBy.mockResolvedValue([
      { mainCategory: 'FILTERS', _count: { _all: 7 } },
    ]);

    const res = await svc.list({});
    expect(res.items.find((c) => c.id === 'filters')!.count).toBe(7);
  });

  it('vehicle scope returns the 8 vehicle-specific categories', async () => {
    const svc = new CategoriesService(prisma);
    prisma.catalogPart.groupBy.mockResolvedValue([{ vehicleCategory: 'BRAKE_SYSTEM', _count: { _all: 4 } }]);

    const res = await svc.list({ scope: 'vehicle' });
    expect(res.total).toBe(8);
    expect(res.items.find((c) => c.id === 'BRAKE_SYSTEM')!.count).toBe(4);
  });

  it('scopes counts to a garage vehicle (universal OR fitting make/model)', async () => {
    const svc = new CategoriesService(prisma);
    prisma.vehicle.findUnique.mockResolvedValue({ make: { name: 'Chevrolet' }, model: { name: 'Cobalt' } });
    prisma.catalogPart.groupBy.mockResolvedValue([]);

    await svc.list({ vehicle_id: 'veh_1' });
    const where = prisma.catalogPart.groupBy.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ isUniversal: true });
    expect(JSON.stringify(where)).toContain('Cobalt');
  });
});
