/* eslint-disable @typescript-eslint/no-explicit-any */
// CAT-001 to CAT-004. Predicates are evaluated in memory by where-eval, so these say
// nothing about the query plans or row counts of a real database.
import { NotFoundException } from '@nestjs/common';
import {
  displayNumbers,
  normalizeOem,
  withSearchForms,
} from '../common/normalize-oem.util';
import { matchesWhere } from './compatibility/where-eval.test-util';
import { computeCompatibility } from './parts/part.presenter';
import {
  PartsService,
  categorySubtreeWhere,
  partOrderBy,
  partTextWhere,
} from './parts/parts.service';
import { SearchService } from './search/search.service';
import { CategoriesService } from './categories/categories.service';
import { catalogRootProductCounts } from './categories/part-category.service';
import {
  categoryTreeScope,
  visibleCategoryWhere,
} from './categories/category-tree-scope';
import {
  compatibilityFacetWhere,
  type VehicleFitContext,
} from './compatibility/vehicle-fitment';
import { findUnavailableParts } from '../orders/order-availability';
import { CartService } from '../cart/cart.service';
import { createPrismaMock, fakeDiscounts } from '../../test/utils/harness';

const listing = (gm: string[], oem: string[] = []) => ({
  title: 'Part',
  gmNumbers: withSearchForms(gm),
  oemNumbers: withSearchForms(oem),
});

describe('article numbers (CAT-001)', () => {
  it.each(['SP-1362', 'SP 1362', 'sp1362', 'sp- 1362.'])('%s finds a listing typed SP-1362', (q) => {
    expect(matchesWhere(listing(['SP-1362']), partTextWhere(q))).toBe(true);
  });

  it('96953062 finds a listing typed 96 953 062', () => {
    expect(matchesWhere(listing(['96 953 062']), partTextWhere('96953062'))).toBe(true);
  });

  it('canonical numbers stay as they are, and stay findable', () => {
    expect(withSearchForms(['96953062'])).toEqual(['96953062']);
    expect(matchesWhere(listing(['96953062']), partTextWhere('96953062'))).toBe(true);
  });

  it('the number as written comes first and is what is shown', () => {
    const stored = withSearchForms(['96 953 062', 'sp-1362']);
    expect(stored[0]).toBe('96 953 062');
    expect(displayNumbers(stored)).toEqual(['96 953 062', 'sp-1362']);
  });

  it('shows a canonical number that is the only form', () => {
    expect(displayNumbers(['96953062'])).toEqual(['96953062']);
  });

  it('two different listings sharing a canonical form both stay, unmerged', () => {
    const a = listing(['SP-1362']);
    const b = listing(['SP 1362']);
    const where = partTextWhere('sp1362');
    expect(matchesWhere(a, where)).toBe(true);
    expect(matchesWhere(b, where)).toBe(true);
    expect(a.gmNumbers).not.toEqual(b.gmNumbers);
  });

  it('does not invent a lookup form for a blank', () => {
    expect(withSearchForms(['---'])).toEqual(['---']);
    expect(normalizeOem('---')).toBe('');
  });
});

const category = (id: string, parentId: string | null, parent?: any) => ({
  id,
  parentId,
  parent: parent ?? null,
});
const root = category('brakes', null);
const child = category('brake-pads', 'brakes', root);
const row = (id: string, cat: any, over: Record<string, unknown> = {}) => ({
  id,
  title: 'Brake pad',
  categoryId: cat.id,
  category: cat,
  gmNumbers: [] as string[],
  oemNumbers: [] as string[],
  images: ['x'],
  priceUzs: 100,
  seller: { status: 'ACTIVE' },
  ...over,
});

describe('search and listing agree (CAT-002)', () => {
  const rows = [
    row('a', child),
    row('b', root, { title: 'Disc', gmNumbers: ['96953062'] }),
    row('c', category('oils', null), { title: 'Oil' }),
    row('hidden', child, { images: [] }),
  ];
  const tree = categoryTreeScope([
    { id: 'brakes', parentId: null },
    { id: 'brake-pads', parentId: 'brakes' },
    { id: 'oils', parentId: null },
  ]);

  async function searchWhere(dto: any) {
    const prisma = createPrismaMock();
    prisma.partCategory.findMany.mockResolvedValue([]);
    prisma.catalogPart.findMany.mockResolvedValue([]);
    prisma.catalogPart.groupBy.mockResolvedValue([]);
    prisma.catalogPart.count.mockResolvedValue(0);
    await new SearchService(prisma, fakeDiscounts()).search(dto);
    return prisma.catalogPart.count.mock.calls[0][0].where;
  }
  const listWhere = (q: any) =>
    (new PartsService(createPrismaMock(), fakeDiscounts()) as any).buildWhere(q, null, tree);
  const ids = (where: any) => rows.filter((r) => matchesWhere(r, where)).map((r) => r.id);

  it('a title query matches the same parts', async () => {
    expect(ids(await searchWhere({ query: 'pad' }))).toEqual(ids(listWhere({ q: 'pad' })));
  });

  it('an article number matches the same parts', async () => {
    const found = ids(await searchWhere({ query: '96953062' }));
    expect(found).toEqual(['b']);
    expect(found).toEqual(ids(listWhere({ q: '96953062' })));
  });

  it('a root category includes its subtree', async () => {
    const found = ids(await searchWhere({ filters: { categories: ['brakes'] } }));
    expect(found.sort()).toEqual(['a', 'b']);
    expect(found.sort()).toEqual(ids(listWhere({ category: 'brakes' })).sort());
  });

  it('ignores a category filter that is not a list of ids', async () => {
    expect(ids(await searchWhere({ filters: { categories: 'brakes' } })).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  const partRow = (id: string, ms: number) => ({
    id,
    title: 'T',
    priceUzs: 250_000,
    categoryId: 'c',
    sellerId: 's',
    createdAt: new Date(ms),
    category: { name: 'c', nameRu: 'c', nameUz: 'c', nameEn: 'c' },
  });

  function paged(all: any[]) {
    const prisma = createPrismaMock();
    prisma.partCategory.findMany.mockResolvedValue([]);
    prisma.catalogPart.groupBy.mockResolvedValue([]);
    prisma.catalogPart.count.mockResolvedValue(all.length);
    prisma.catalogPart.findMany.mockImplementation(async ({ skip, take, orderBy }: any) => {
      expect(orderBy).toEqual(partOrderBy(undefined));
      // Newest first, ties by id: what the listing's own order gives.
      const sorted = [...all].sort(
        (x, y) => y.createdAt.getTime() - x.createdAt.getTime() || x.id.localeCompare(y.id),
      );
      return sorted.slice(skip, skip + take);
    });
    return prisma;
  }

  it('walks every page with no skip or repeat, across equal timestamps', async () => {
    const all = [
      partRow('e', 5), partRow('d', 4), partRow('c', 4), partRow('b', 4), partRow('a', 1),
    ];
    const svc = new SearchService(paged(all), fakeDiscounts());
    const seen: string[] = [];
    let token: string | null = null;
    do {
      const page: any = await svc.search({ limit: 2, pageToken: token } as any);
      seen.push(...page.results.map((r: any) => r.id));
      token = page.nextPageToken;
    } while (token);
    expect(seen).toEqual(['e', 'b', 'c', 'd', 'a']);
  });

  it.each([
    ['price_asc', [{ priceUzs: 'asc' }, { id: 'asc' }]],
    ['price_desc', [{ priceUzs: 'desc' }, { id: 'asc' }]],
    ['relevance', [{ createdAt: 'desc' }, { id: 'asc' }]],
    ['newest', [{ createdAt: 'desc' }, { id: 'asc' }]],
    ['rating', [{ createdAt: 'desc' }, { id: 'asc' }]],
  ])('sort %s orders search as it orders the listing', async (sortBy, expected) => {
    const prisma = paged([]);
    prisma.catalogPart.findMany.mockImplementation(async () => []);
    await new SearchService(prisma, fakeDiscounts()).search({ sortBy } as any);
    const { orderBy } = prisma.catalogPart.findMany.mock.calls[0][0];
    expect(orderBy).toEqual(expected);
    expect(orderBy).toEqual(partOrderBy(sortBy));
  });

  it('refuses a negative or fractional page token', async () => {
    const svc = new SearchService(paged([]), fakeDiscounts());
    const token = (v: unknown) => Buffer.from(JSON.stringify([v])).toString('base64url');
    await expect(svc.search({ pageToken: token(-1) } as any)).rejects.toMatchObject({ status: 400 });
    await expect(svc.search({ pageToken: token(1.5) } as any)).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a malformed page token', async () => {
    const svc = new SearchService(paged([]), fakeDiscounts());
    await expect(svc.search({ pageToken: 'garbage!' } as any)).rejects.toMatchObject({ status: 400 });
  });

  it('shows the sale price, by the same calculation as the detail page', async () => {
    const all = [partRow('a', 1)];
    const discounts = fakeDiscounts();
    jest
      .spyOn(discounts, 'calculateDiscount')
      .mockReturnValue({ finalPrice: 25, discountPercent: 99.99 } as never);
    const res: any = await new SearchService(paged(all), discounts).search({});
    expect(discounts.calculateDiscount).toHaveBeenCalledWith(
      250_000,
      { id: 'a', categoryId: 'c', sellerId: 's' },
      [],
    );
    expect(res.results[0].price).toContain('25');
    expect(res.results[0]).toEqual(
      expect.objectContaining({ id: 'a', title: 'T', category_id: 'c' }),
    );
  });

  it('keeps the page cap', async () => {
    const prisma = paged([]);
    await new SearchService(prisma, fakeDiscounts()).search({ limit: 500 } as any);
    expect(prisma.catalogPart.findMany.mock.calls[0][0].take).toBe(51);
  });

  it('exports the subtree rule it shares', () => {
    expect(matchesWhere(rows[0], categorySubtreeWhere('brakes'))).toBe(true);
  });
});

describe('category visibility (CAT-003)', () => {
  const edges = [
    { id: 'brakes', parentId: null, isActive: true },
    { id: 'brake-pads', parentId: 'brakes', isActive: false },
    { id: 'front-pads', parentId: 'brake-pads', isActive: true },
    { id: 'rul', parentId: null, isActive: false },
    { id: 'rul-sub', parentId: 'rul', isActive: true },
    { id: 'other', parentId: null, isActive: true },
    { id: 'cat_uncategorized', parentId: null, isActive: true },
  ];
  const tree = categoryTreeScope(edges);

  it.each([
    ['an inactive child', 'brake-pads', true],
    ['anything beneath an inactive child', 'front-pads', true],
    ['an inactive root', 'rul', true],
    ['anything beneath an inactive root', 'rul-sub', true],
    ['its active parent', 'brakes', false],
    ['`other`', 'other', false],
    ['uncategorized', 'cat_uncategorized', false],
    ['a node the tree has not got', 'nope', false],
  ])('%s', (_label, id, hidden) => {
    expect(tree.isHidden(id)).toBe(hidden);
  });

  it('adds no condition when nothing is hidden', () => {
    expect(visibleCategoryWhere(categoryTreeScope([{ id: 'a', parentId: null }]))).toBeNull();
  });

  it('survives a cycle', () => {
    const looped = categoryTreeScope([
      { id: 'a', parentId: 'b', isActive: true },
      { id: 'b', parentId: 'a', isActive: true },
      { id: 'c', parentId: null, isActive: false },
    ]);
    expect(looped.isHidden('a')).toBe(false);
  });

  it('the grid does not count hidden parts', async () => {
    const prisma = createPrismaMock();
    prisma.partCategory.findMany.mockResolvedValue(edges);
    prisma.catalogPart.groupBy.mockResolvedValue([]);
    await new CategoriesService(prisma).list({ scope: 'main' } as any);
    expect(JSON.stringify(prisma.catalogPart.groupBy.mock.calls[0][0].where)).toContain('notIn');
  });

  it('search and typeahead apply the same rule', async () => {
    const prisma = createPrismaMock();
    prisma.partCategory.findMany.mockResolvedValue(edges);
    prisma.catalogPart.findMany.mockResolvedValue([]);
    prisma.catalogPart.groupBy.mockResolvedValue([]);
    prisma.catalogPart.count.mockResolvedValue(0);
    const svc = new SearchService(prisma, fakeDiscounts());
    await svc.search({ query: 'x' });
    await svc.typeahead('x');
    const wheres = prisma.catalogPart.findMany.mock.calls.map((c: any[]) => c[0].where);
    expect(JSON.stringify(wheres[0])).toContain('notIn');
    expect(JSON.stringify(wheres[1])).toContain('notIn');
  });

  it('the detail page does not serve a hidden part', async () => {
    const prisma = createPrismaMock();
    prisma.catalogPart.findFirst.mockResolvedValue({ id: 'p', categoryId: 'rul-sub' });
    prisma.partCategory.findMany.mockResolvedValue(edges);
    const service = new PartsService(prisma, fakeDiscounts());
    await expect(service.detail('p')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a hidden part cannot be added to a cart', async () => {
    const prisma = createPrismaMock();
    prisma.cart.upsert.mockResolvedValue({ id: 'c', userId: 'u', items: [] });
    prisma.catalogPart.findFirst.mockResolvedValue({ inStock: true, stockQty: 0, categoryId: 'brake-pads' });
    prisma.partCategory.findMany.mockResolvedValue(edges);
    await expect(
      new CartService(prisma, fakeDiscounts()).addItem('u', { part_id: 'p' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });

  it('neither compatibility endpoint answers for a hidden part', async () => {
    const prisma = createPrismaMock();
    prisma.catalogPart.findUnique.mockResolvedValue({
      id: 'p',
      categoryId: 'front-pads',
      compatibilities: [],
      fitmentBindings: [],
    });
    prisma.partCategory.findMany.mockResolvedValue(edges);
    const service = new PartsService(prisma, fakeDiscounts());
    await expect(service.compatibility('p', 'v')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.checkCompatibility('p', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a saved cart line cannot be raised once its category is hidden', async () => {
    const prisma = createPrismaMock();
    prisma.cartItem.findUnique.mockResolvedValue({ id: 'i', partId: 'p', title: 'F', cart: { userId: 'u' } });
    prisma.partCategory.findMany.mockResolvedValue(edges);
    prisma.catalogPart.findMany.mockResolvedValue([
      { id: 'p', inStock: true, stockQty: 0, priceUzs: 100, categoryId: 'rul', seller: { status: 'ACTIVE' } },
    ]);
    await expect(
      new CartService(prisma, fakeDiscounts()).updateItem('u', 'i', 2),
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  describe('counts match what is listed', () => {
    const rows = [
      row('shown', { id: 'brakes', parentId: null, parent: null }),
      row('gone-child', { id: 'brake-pads', parentId: 'brakes', parent: null }),
      row('gone-below', { id: 'front-pads', parentId: 'brake-pads', parent: null }),
      row('gone-root', { id: 'rul-sub', parentId: 'rul', parent: null }),
      row('other-part', { id: 'other', parentId: null, parent: null }),
      row('unfiled', { id: 'cat_uncategorized', parentId: null, parent: null }),
    ];

    it('a listing leaves exactly the visible parts', () => {
      const where = (new PartsService(createPrismaMock(), fakeDiscounts()) as any).buildWhere({}, null, tree);
      expect(rows.filter((r) => matchesWhere(r, where)).map((r) => r.id)).toEqual([
        'shown',
        'other-part',
        'unfiled',
      ]);
    });

    it('root counts leave out what is hidden, keep `other`, and offer no uncategorized tile', () => {
      const nodes = edges.map((e) => ({ ...e, level: e.parentId ? 1 : 0, isActive: e.isActive }));
      const counts = catalogRootProductCounts(
        nodes.map((n) => (n.id === 'cat_uncategorized' ? { ...n, level: 1 } : n)),
        [['brakes', 1], ['brake-pads', 1], ['front-pads', 1], ['rul-sub', 1], ['other', 1], ['cat_uncategorized', 1]],
      );
      expect(counts.brakes).toBe(1);
      expect(counts.other).toBe(1);
      expect(counts.cat_uncategorized).toBeUndefined();
      expect(counts.rul).toBeUndefined();
    });
  });

  it('a hidden part cannot be ordered or invoiced', async () => {
    const prisma = createPrismaMock();
    prisma.partCategory.findMany.mockResolvedValue(edges);
    prisma.catalogPart.findMany.mockResolvedValue([
      { id: 'p', inStock: true, stockQty: 0, priceUzs: 100, categoryId: 'rul', seller: { status: 'ACTIVE' } },
    ]);
    await expect(
      findUnavailableParts(prisma, [{ partId: 'p', title: 'F', quantity: 1 }]),
    ).resolves.toEqual([{ partId: 'p', title: 'F', reason: 'category_hidden' }]);
  });
});

describe('the compatibility facet (CAT-004)', () => {
  const vehicles: VehicleFitContext[] = [
    { modelId: 'm1', makeName: 'A', modelName: 'B', trimId: 't1', engineId: 'e1', year: 2020 },
    { modelId: 'm1', makeName: 'A', modelName: 'B', trimId: null, engineId: null, year: 2020 },
    { modelId: null, makeName: 'A', modelName: 'B', trimId: 't1', engineId: null, year: 2020 },
  ];
  const statuses = ['FITS', 'MAYBE', 'DOES_NOT_FIT'] as const;
  const trimRows = [
    [],
    ...statuses.map((status) => [{ trimId: 't1', engineId: null, years: [], status, confidence: 1 }]),
    [{ trimId: 't1', engineId: null, years: [1999], status: 'FITS', confidence: 1 }],
    [{ trimId: 't1', engineId: null, years: [2020], status: 'FITS', confidence: 1 }],
    [{ trimId: 't2', engineId: null, years: [], status: 'FITS', confidence: 1 }],
  ];
  const engineRows = [
    [],
    ...statuses.map((status) => [{ trimId: null, engineId: 'e1', years: [], status, confidence: 1 }]),
    [{ trimId: null, engineId: 'e2', years: [], status: 'FITS', confidence: 1 }],
  ];
  const bindings = [[], [{ vehicleModelId: 'm1' }], [{ vehicleModelId: 'm2' }]];

  it('agrees with the per-part decision in every combination', () => {
    let checked = 0;
    for (const vehicle of vehicles) {
      const where = compatibilityFacetWhere(vehicle);
      for (const trim of trimRows) {
        for (const engine of engineRows) {
          for (const fitmentBindings of bindings) {
            const compatibilities = [...trim, ...engine];
            const part = { compatibilities, fitmentBindings };
            const decided = computeCompatibility(
              compatibilities as never,
              vehicle,
              fitmentBindings.map((b) => b.vehicleModelId),
            )?.status;
            expect(matchesWhere(part, where.fits)).toBe(decided === 'fits');
            expect(matchesWhere(part, where.doesNotFit)).toBe(decided === 'does_not_fit');
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('a universal part with no fitment data is a maybe', () => {
    const where = compatibilityFacetWhere(vehicles[0]);
    const part = { compatibilities: [], fitmentBindings: [], isUniversal: true };
    expect(matchesWhere(part, where.fits)).toBe(false);
    expect(matchesWhere(part, where.doesNotFit)).toBe(false);
  });

  it('never reads the matching parts into memory', async () => {
    const prisma = createPrismaMock();
    prisma.catalogPart.count
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(60)
      .mockResolvedValueOnce(10);
    prisma.catalogPart.findMany.mockResolvedValue([]);
    prisma.catalogPart.groupBy.mockResolvedValue([]);
    prisma.catalogPart.aggregate.mockResolvedValue({ _min: {}, _max: {} });
    prisma.partBrand.findMany.mockResolvedValue([]);
    prisma.partCategory.findMany.mockResolvedValue([]);
    prisma.vehicle.findFirst.mockResolvedValue({
      modelId: 'm1', trimId: null, engineId: null, year: 2020, make: { name: 'A' }, model: { name: 'B' },
    });
    const res: any = await new PartsService(prisma, fakeDiscounts()).list(
      { vehicle_id: 'v1' } as any,
      undefined,
      'u1',
    );
    for (const [args] of prisma.catalogPart.findMany.mock.calls as any[]) {
      expect(args.take).toBeGreaterThan(0);
    }
    expect(res.facets.compatibility).toEqual({ fits: 60, maybe: 30, does_not_fit: 10 });
    expect(res.total).toBe(100);
  });
});
