import { SearchService } from '../../src/catalog/search/search.service';
import { PartsService } from '../../src/catalog/parts/parts.service';
import { createPrismaMock, PrismaMock } from '../utils/harness';

function buildPart(over: Partial<any> = {}): any {
  return {
    id: 'part_belt',
    title: 'Timing belt',
    brand: { id: 'brand_gates', name: 'Gates' },
    category: { id: 'cat_belts', name: 'Timing belts' },
    seller: { id: 'seller_1', name: 'Avtomir', ratingAvg: 4.6 },
    compatibilities: [],
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
      { id: 'part_belt', title: 'Timing belt', priceUzs: 185000, category: { id: 'cat_belts', name: 'Timing belts' } },
    ]);
    prisma.catalogPart.groupBy.mockResolvedValue([{ categoryId: 'cat_belts', _count: { _all: 2 } }]);
    prisma.partCategory.findMany.mockResolvedValue([{ id: 'cat_belts', name: 'Timing belts' }]);

    const res = await svc.search({ query: 'belt' } as any);

    expect(res.total).toBe(2);
    expect(res.results[0].price).toBe('UZS 185 000');
    expect(res.facetCounts.categories['Timing belts']).toBe(2);
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
    const svc = new PartsService(prisma);
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
    const svc = new PartsService(prisma);
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
});
