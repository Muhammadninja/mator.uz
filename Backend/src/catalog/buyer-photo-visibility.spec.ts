/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// No buyer-facing catalog read returns a part without a READY photo. It is
// decided in the `where` itself, so no count, facet or page includes such a
// part, while the admin console still sees every part. Each read runs its
// real `where` over in-memory parts (where-eval); Prisma is mocked.

import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PartsService } from './parts/parts.service';
import { CategoriesService } from './categories/categories.service';
import { SearchService } from './search/search.service';
import { BUYER_LISTED_PART, BUYER_VISIBLE_PART } from './buyer-visibility';
import { matchesWhere, selectIds } from './compatibility/where-eval.test-util';
import * as fx from './compatibility/fitment-fixtures.test-util';
import { ListPartsQueryDto } from './parts/dto/list-parts.query.dto';
import { RagSearchService } from '../ai-chat/rag-search.service';
import { CatalogToolsService } from '../ai-advisor/catalog-tools.service';
import { FitmentQueueService } from '../admin/fitment-studio/fitment-queue.service';
import { AdminInventoryService } from '../admin/inventory/admin-inventory.service';
import { createPrismaMock, fakeDiscounts } from '../../test/utils/harness';

const noDiscounts = {
  loadActiveSales: jest.fn().mockResolvedValue([]),
  calculateDiscount: (price: number) => ({
    originalPrice: price,
    finalPrice: price,
    discountAmount: 0,
    discountPercent: 0,
    appliedSale: null,
  }),
};

type Row = Record<string, any> & { id: string };

const OWNER = 'usr_owner';
const BRAKES = {
  id: 'brakes',
  name: 'Brakes',
  nameRu: 'Тормоза',
  nameUz: 'Tormozlar',
  nameEn: 'Brakes',
  slug: 'brakes',
  iconKey: 'brakes',
  color: '#EA4335',
  mainCategory: 'BRAKES',
  sortOrder: 0,
};

/** Order like the database for the rules these reads use ('asc' / 'desc' /
 *  { sort }), NULLs last; ties keep fixture order. */
function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const specs = [orderBy ?? []].flat() as Record<string, unknown>[];
  const key = (v: unknown) => (v instanceof Date ? v.getTime() : v) as number;
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [field, rule] = Object.entries(spec)[0];
      const sort =
        typeof rule === 'string' ? rule : (rule as { sort: string }).sort;
      const [av, bv] = [a[field], b[field]];
      if (av == null || bv == null) {
        if (av == null && bv == null) continue;
        return av == null ? 1 : -1;
      }
      if (key(av) === key(bv)) continue;
      return (key(av) < key(bv) ? -1 : 1) * (sort === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

/** Prisma double over in-memory catalog rows: every read runs its real `where`. */
function catalogStore(rows: Row[]) {
  const hit = (where: unknown) => rows.filter((r) => matchesWhere(r, where));
  return {
    catalogPart: {
      count: jest.fn((a: { where?: unknown }) =>
        Promise.resolve(hit(a.where).length),
      ),
      findMany: jest.fn(
        (a: {
          where?: unknown;
          orderBy?: unknown;
          skip?: number;
          take?: number;
        }) => {
          const rest = sortRows(hit(a.where), a.orderBy).slice(a.skip ?? 0);
          return Promise.resolve(
            a.take === undefined ? rest : rest.slice(0, a.take),
          );
        },
      ),
      findFirst: jest.fn((a: { where?: unknown }) =>
        Promise.resolve(hit(a.where)[0] ?? null),
      ),
      groupBy: jest.fn(
        (a: {
          by: string[];
          where?: unknown;
          orderBy?: unknown;
          take?: number;
        }) => {
          const counts = new Map<unknown, number>();
          for (const r of hit(a.where))
            counts.set(r[a.by[0]], (counts.get(r[a.by[0]]) ?? 0) + 1);
          const groups = [...counts].map(([value, n]) => ({
            [a.by[0]]: value,
            _count: { _all: n },
          }));
          if (a.orderBy) groups.sort((x, y) => y._count._all - x._count._all);
          return Promise.resolve(
            a.take === undefined ? groups : groups.slice(0, a.take),
          );
        },
      ),
      aggregate: jest.fn((a: { where?: unknown }) => {
        const prices = hit(a.where).map((r) => r.priceUzs as number);
        return Promise.resolve({
          _min: { priceUzs: prices.length ? Math.min(...prices) : null },
          _max: { priceUzs: prices.length ? Math.max(...prices) : null },
        });
      }),
    },
    partBrand: { findMany: jest.fn().mockResolvedValue([]) },
    partCategory: { findMany: jest.fn().mockResolvedValue([BRAKES]) },
    // The garage Cobalt resolves only for its owner, like the database.
    vehicle: {
      findFirst: jest.fn((a: { where: { userId?: string } }) =>
        Promise.resolve(
          a.where.userId === OWNER ? fx.vehicleRow(fx.VEHICLES.cobalt) : null,
        ),
      ),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

let created = 0;
/** A catalog_parts row with every column and relation the buyer reads touch. */
function catalogRow(base: Row, over: Partial<Row> = {}): Row {
  created += 1;
  return {
    title: `Тормозные колодки ${base.id}`,
    kind: 'SPARE_PART',
    categoryId: 'brakes',
    category: BRAKES,
    mainCategory: 'BRAKES',
    vehicleCategory: 'BRAKE_SYSTEM',
    brandId: 'brand_bosch',
    brand: { id: 'brand_bosch', name: 'Bosch' },
    oemNumbers: ['96611630'],
    gmNumbers: [],
    originRegion: 'KOREA',
    isOem: true,
    isGm: false,
    priceUzs: 150_000,
    currency: 'UZS',
    inStock: true,
    createdAt: new Date(Date.UTC(2026, 9, 1) + created * 60_000),
    ...base,
    seller: {
      id: 'dealer_1',
      name: 'Avtomir',
      ratingAvg: 4.6,
      certified: false,
      lowestPrice: false,
      ...base.seller,
    },
    ...over,
  };
}
const photographed = (id: string, over: Partial<Row> = {}) =>
  catalogRow(fx.part({ id, isUniversal: true }), over);
const withoutPhoto = (id: string, over: Partial<Row> = {}) =>
  catalogRow(fx.part({ id, isUniversal: true, images: [] }), over);

const partsService = (rows: Row[]) =>
  new PartsService(catalogStore(rows) as never, noDiscounts as never);
const ids = (res: { items: { id: string }[] }) => res.items.map((i) => i.id);

describe('buyer catalog — only parts with a ready photo are listed', () => {
  it('one ready photo is enough; none — an empty or a NULL list — is not', () => {
    const rows = [
      withoutPhoto('no_photo'),
      catalogRow(fx.part({ id: 'null_images', images: null })),
      photographed('one_photo'),
      photographed('two_photos', {
        images: [fx.READY_PHOTO, 'https://res.cloudinary.com/mator/proc/2.png'],
      }),
    ];
    expect(selectIds(rows, BUYER_LISTED_PART)).toEqual([
      'one_photo',
      'two_photos',
    ]);
    // It is the suspended-dealer rule plus the photo rule, not instead of it.
    expect(BUYER_LISTED_PART).toMatchObject(BUYER_VISIBLE_PART);
    const suspended = photographed('suspended', {
      seller: { status: 'SUSPENDED' },
    });
    expect(selectIds([suspended], BUYER_LISTED_PART)).toEqual([]);
  });

  it('GET /v1/catalog/parts filters before skip/take: full pages, totals and facets of listed parts only', async () => {
    // 7 photographed parts, each followed by one without a photo (newest last).
    const rows = Array.from({ length: 7 }, (_, i) => [
      photographed(`ok_${i}`),
      withoutPhoto(`bare_${i}`, {
        priceUzs: 9_000_000,
        brandId: 'brand_other',
        brand: { id: 'brand_other', name: 'Other' },
      }),
    ]).flat();
    const svc = partsService(rows);

    const pages: Awaited<ReturnType<PartsService['list']>>[] = [];
    for (const page of [1, 2, 3])
      pages.push(await svc.list({ page, page_size: 3 }));

    // Newest first, 3 + 3 + 1: no page is short or empty while parts remain.
    expect(pages.map(ids)).toEqual([
      ['ok_6', 'ok_5', 'ok_4'],
      ['ok_3', 'ok_2', 'ok_1'],
      ['ok_0'],
    ]);
    expect(pages.map((p) => p.total)).toEqual([7, 7, 7]);
    expect(pages.map((p) => p.next_page)).toEqual([2, 3, null]);
    // The facets count the same set: the photo-less parts' brand and price are absent.
    expect(pages[0].facets.brands).toEqual([
      { id: 'brand_bosch', name: 'brand_bosch', count: 7 },
    ]);
    expect(pages[0].facets.price_range_uzs).toEqual({
      min: 150_000,
      max: 150_000,
    });
  });

  it('GET /v1/catalog/parts/:id serves a photographed part and 404s one without a photo', async () => {
    const svc = partsService([photographed('ok'), withoutPhoto('bare')]);
    await expect(svc.detail('ok')).resolves.toMatchObject({
      id: 'ok',
      images: [fx.READY_PHOTO],
    });
    await expect(svc.detail('bare')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('filters and garage compatibility drop exactly the parts without a photo', () => {
    const BARE = '__no_photo';
    // Every fitment shape of the compatibility fixtures, and a twin of each
    // that is identical except that it has no photo.
    const WITH_PHOTO = fx.PARTS.map((p) => catalogRow(p));
    const TWINS = fx.PARTS.map((p) =>
      catalogRow({ ...p, id: `${p.id}${BARE}`, images: [] }),
    );

    async function listIds(rows: Row[], query: Partial<ListPartsQueryDto>) {
      const res = await partsService(rows).list(
        { page_size: 100, ...query },
        'ru',
        OWNER,
      );
      // The count is computed over the same set as the page.
      expect(res.total).toBe(res.items.length);
      return ids(res).sort();
    }

    it.each<[string, Partial<ListPartsQueryDto>]>([
      ['no filter', {}],
      ['make', { make: 'Chevrolet' }],
      ['make + model (garage screen)', { make: 'Chevrolet', model: 'Cobalt' }],
      ['model slug', { model: 'model_chevrolet_spark' }],
      ['garage vehicle compatibility', { vehicle_id: 'veh_1' }],
      ['category rollup', { category: 'brakes' }],
      ['vehicle category', { vehicle_category: 'BRAKE_SYSTEM' }],
      ['part brand', { brand: 'brand_bosch' }],
      ['region', { region: ['korea'] }],
      ['OEM only', { oem_only: 'true' }],
      ['in stock only', { in_stock_only: 'true' }],
      ['title search', { q: 'колодки' }],
      ['article search', { q: '96611630' }],
      ['kind', { kind: ['spare_part'] }],
    ])('%s', async (_name, query) => {
      const shown = await listIds([...WITH_PHOTO, ...TWINS], query);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.filter((id) => id.endsWith(BARE))).toEqual([]);
      // Not vacuous: given a photo, the twins pass the very same filter.
      const twinsWithPhoto = TWINS.map((t) => ({
        ...t,
        images: [fx.READY_PHOTO],
      }));
      expect(await listIds(twinsWithPhoto, query)).toEqual(
        shown.map((id) => `${id}${BARE}`).sort(),
      );
    });

    it('the garage compatibility facet counts only listed parts', async () => {
      const res = await partsService([...WITH_PHOTO, ...TWINS]).list(
        { vehicle_id: 'veh_1', page_size: 100 },
        'ru',
        OWNER,
      );
      const { fits, maybe, does_not_fit } = res.facets.compatibility!;
      expect(fits + maybe + does_not_fit).toBe(res.total);
    });
  });

  it('GET /v1/categories counts only photographed parts, unscoped and per garage vehicle', async () => {
    const store = catalogStore([
      photographed('a'),
      withoutPhoto('b'),
      photographed('c'),
      catalogRow(fx.part({ id: 'spark_only', curated: ['spark'] })),
    ]);
    const svc = new CategoriesService(store as never);
    const countOf = (
      r: { items: { id: string; count: number }[] },
      id: string,
    ) => r.items.find((c) => c.id === id)!.count;

    expect(countOf(await svc.list({}), 'brakes')).toBe(3);
    expect(countOf(await svc.list({ scope: 'vehicle' }), 'BRAKE_SYSTEM')).toBe(
      3,
    );
    // The Cobalt sees the two universal photographed parts, not the Spark one.
    const garage = await svc.list({ vehicle_id: 'veh_1' }, 'ru', OWNER);
    expect(countOf(garage, 'brakes')).toBe(2);
  });

  it('POST /v1/search: total, results and every facet count only photographed parts', async () => {
    const svc = new SearchService(
      catalogStore([
        photographed('cheap_ok'),
        withoutPhoto('cheap_bare'),
        photographed('mid_ok', { priceUzs: 300_000 }),
        withoutPhoto('mid_bare', { priceUzs: 300_000 }),
      ]) as never,
    );
    const res = await svc.search({ query: 'колодки' });

    expect(res.total).toBe(2);
    expect(res.results.map((r) => r.id)).toEqual(['mid_ok', 'cheap_ok']);
    expect(res.facetCounts.price).toEqual({ under_200k: 1, '200k_to_500k': 1 });
    expect(res.facetCounts.minRating['4plus']).toBe(2);
    expect(res.categories).toEqual([
      { id: 'brakes', name: 'Тормоза', count: 2 },
    ]);
  });

  it('GET /v1/typeahead suggests only photographed parts', async () => {
    const svc = new SearchService(
      catalogStore([photographed('ok'), withoutPhoto('bare')]) as never,
    );
    const { suggestions } = await svc.typeahead('колодки');
    expect(suggestions.filter((s) => s.type === 'product')).toEqual([
      {
        text: 'Тормозные колодки ok',
        type: 'product',
        deeplink: '/(tabs)/(explore)/item-detail/ok',
      },
    ]);
  });

  it('GET /v1/search/quick-filters offers no chip that only photo-less parts fill', async () => {
    const other = {
      brandId: 'brand_gates',
      brand: { id: 'brand_gates', name: 'Gates' },
    };
    const svc = new SearchService(
      catalogStore([
        photographed('ok_1'),
        photographed('ok_2'),
        withoutPhoto('bare_bosch'),
        withoutPhoto('bare_gates_1', other),
        withoutPhoto('bare_gates_2', other),
      ]) as never,
    );
    const { items } = await svc.quickFilters();
    expect(items.map((i) => [i.label, i.count])).toEqual([['brand_bosch', 2]]);
  });

  it('the AI chat quotes only photographed parts, and a part without one is "not in stock"', async () => {
    const query = { partName: 'колодки', brand: null, model: null };
    const rag = (rows: Row[]) =>
      new RagSearchService(
        catalogStore(rows) as never,
        fakeDiscounts(),
      ).searchInStock(query);
    // RAG ranks by price with Decimal arithmetic, as the client returns it.
    const price = { priceUzs: new Prisma.Decimal(150_000) };

    const res = await rag([
      photographed('ok', price),
      photographed('ok_2', price),
      withoutPhoto('bare', price),
    ]);
    expect(res.items.map((i) => i.id).sort()).toEqual(['ok', 'ok_2']);
    // Only photo-less matches: the chat answers "not found" (→ sourcing ticket),
    // exactly as for a suspended dealer's part.
    expect(await rag([withoutPhoto('bare', price)])).toEqual({
      found: false,
      items: [],
    });
  });

  it('the AI advisor catalog tools find only photographed parts', async () => {
    const store = catalogStore([photographed('ok'), withoutPhoto('bare')]);
    const tools = new CatalogToolsService(
      new PartsService(store as never, noDiscounts as never),
      new CategoriesService(store as never),
    );

    const search = JSON.parse(
      (await tools.run('search_catalog', { q: 'колодки' })).content,
    );
    expect(search.items.map((i: { part_id: string }) => i.part_id)).toEqual([
      'ok',
    ]);
    expect(search.total).toBe(1);

    const product = JSON.parse(
      (await tools.run('get_product', { part_id: 'bare' })).content,
    );
    expect(product.error).toBe('No catalogue part with id "bare".');
  });
});

describe('admin reads keep the parts without photos', () => {
  const adminRow = (id: string, images: string[]) =>
    catalogRow(fx.part({ id, images }), {
      fitmentPriority: null,
      category: { ...BRAKES, parent: null },
      fitmentBindings: [],
    });

  it('GET /v1/admin/fitment/parts-queue lists a part without photos', async () => {
    const store = catalogStore([
      adminRow('bare', []),
      adminRow('ok', [fx.READY_PHOTO]),
    ]);
    const res = await new FitmentQueueService(store as never).getPartsQueue({
      limit: 300,
      filter: 'all',
    });
    expect(res.data.map((r) => r.id)).toEqual(['bare', 'ok']);
    expect(res.data[0].imageUrl).toBeNull();
    expect(res.meta.total).toBe(2);
  });

  it('GET /v1/admin/inventory lists a part without photos: no photo predicate anywhere', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ count: 2n }])
      .mockResolvedValueOnce([{ id: 'bare' }, { id: 'ok' }]);
    const inventoryRow = (id: string) => ({
      id,
      title: 'Колодки',
      oemNumbers: [],
      gmNumbers: [],
      stockQty: 3,
      lowStockThreshold: 5,
      purchasePriceUzs: null,
      priceUzs: 150_000,
      cashbackPct: 0,
      brand: null,
      category: BRAKES,
    });
    prisma.catalogPart.findMany.mockResolvedValue([
      inventoryRow('bare'),
      inventoryRow('ok'),
    ]);

    const res = await new AdminInventoryService(prisma).list({});

    expect(res.data.map((r) => r.id)).toEqual(['bare', 'ok']);
    expect(res.meta.totalItems).toBe(2);
    for (const [sql] of prisma.$queryRaw.mock.calls) {
      expect((sql as { sql: string }).sql).not.toMatch(/images/);
    }
    expect(prisma.catalogPart.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['bare', 'ok'] },
    });
  });
});
