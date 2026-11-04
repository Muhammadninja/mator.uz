// GET /v1/catalog/parts?category=<id> over the category TREE. A buyer who opens
// a system on the home grid without a car must see every part of that system,
// whichever node it is filed on: the system root itself, a subcategory, an
// intermediate node (wheel-hubs-bearings) or one nested below it (ball/roller
// bearings). The listing's real predicate runs over in-memory parts
// (where-eval), so these tests assert WHICH parts come back — and that count,
// paging, sort, search and the model filter all ride on the same predicate.

import { PartMainCategory as B } from '@prisma/client';
import { PartsService } from './parts.service';
import { ListPartsQueryDto } from './dto/list-parts.query.dto';
import { matchesWhere, selectIds } from '../compatibility/where-eval.test-util';
import * as fx from '../compatibility/fitment-fixtures.test-util';

/** `parent_id` edges as the part_categories table holds them for these systems. */
const PARENT: Record<string, string | null> = {
  'brake-system': null,
  brakes: 'brake-system', // a home-grid bucket row — a child like any other
  'front-brake-pads': 'brake-system',
  'rear-brake-pads': 'brake-system',
  'brake-discs': 'brake-system',
  'brake-calipers-kits': 'brake-system',
  'brake-cylinders': 'brake-system',
  'brake-hoses-cables': 'brake-system',
  'suspension-and-steering': null,
  'shock-absorbers': 'suspension-and-steering',
  'wheel-hubs-bearings': 'suspension-and-steering',
  'ball-bearings': 'wheel-hubs-bearings',
  'roller-bearings': 'wheel-hubs-bearings',
  suspension: 'suspension-and-steering',
  other: null,
  'motorcycle-oil': 'other',
  'fasteners-and-clips': 'other',
  'wiper-blades': 'other',
  cat_uncategorized: null,
};

/** A category as Prisma resolves `category.parent.parent…`. */
function node(id: string): Record<string, unknown> {
  const parentId = PARENT[id];
  return { id, parentId, parent: parentId ? node(parentId) : null };
}

function filed(
  id: string,
  categoryId: string,
  mainCategory: B | null,
  over: Partial<Parameters<typeof fx.part>[0]> & {
    title?: string;
    priceUzs?: number;
  } = {},
) {
  const { title, priceUzs, ...spec } = over;
  return {
    ...fx.part({ id, ...spec }),
    title: title ?? id,
    priceUzs: priceUzs ?? 100_000,
    categoryId,
    category: node(categoryId),
    mainCategory,
  };
}

const PARTS = [
  filed('b_root', 'brake-system', B.BRAKES),
  filed('b_bucket', 'brakes', B.BRAKES),
  filed('b_front', 'front-brake-pads', B.BRAKES),
  filed('b_rear', 'rear-brake-pads', B.BRAKES),
  filed('b_discs', 'brake-discs', B.BRAKES),
  filed('b_calipers', 'brake-calipers-kits', B.BRAKES),
  filed('b_cylinders', 'brake-cylinders', B.BRAKES),
  filed('b_hoses', 'brake-hoses-cables', B.BRAKES),
  // Not buyer-listed (no ready photo): never listed, never counted.
  filed('b_no_photo', 'front-brake-pads', B.BRAKES, { images: [] }),

  filed('s_root', 'suspension-and-steering', B.SUSPENSION),
  filed('s_shock', 'shock-absorbers', B.SUSPENSION, {
    title: 'Shock absorber KYB',
  }),
  filed('s_hubs', 'wheel-hubs-bearings', B.SUSPENSION, {
    title: 'Wheel hub assembly',
  }),
  filed('s_ball', 'ball-bearings', B.SUSPENSION, {
    title: 'Ball bearing 6204',
    fits: [['Chevrolet', 'Cobalt']],
  }),
  filed('s_roller', 'roller-bearings', B.SUSPENSION, {
    title: 'Roller bearing 30205',
    fits: [['Kia', 'K5']],
  }),
  filed('s_bucket', 'suspension', B.SUSPENSION),

  filed('o_moto', 'motorcycle-oil', null, { isUniversal: true }),
  filed('o_fasteners', 'fasteners-and-clips', null, { isUniversal: true }),
  filed('o_wipers', 'wiper-blades', B.WIPERS, { isUniversal: true }),

  filed('u_none', 'cat_uncategorized', null),
];

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

/** The page query `list` sends Prisma. */
interface PageQuery {
  where: unknown;
  skip: number;
  take: number;
  orderBy: unknown;
}

/** Prisma double: counts run the real `where` over PARTS; the page query is
 *  recorded (its rows are not needed — the ids come from the same `where`). */
function makeService() {
  const calls: { count?: { where: unknown }; findMany?: PageQuery } = {};
  const prisma = {
    catalogPart: {
      count: jest.fn((args: { where: unknown }) => {
        calls.count = args;
        return Promise.resolve(
          PARTS.filter((p) => matchesWhere(p, args.where)).length,
        );
      }),
      findMany: jest.fn((args: PageQuery) => {
        calls.findMany = args;
        return Promise.resolve([]);
      }),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _min: {}, _max: {} }),
    },
    partBrand: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  return {
    svc: new PartsService(prisma as never, NO_DISCOUNTS as never),
    calls,
  };
}

/** List with `query`: the ids its predicate selects, the response, and the
 *  page query it sent. */
async function listing(query: ListPartsQueryDto) {
  const { svc, calls } = makeService();
  const res = await svc.list(query);
  const page = calls.findMany!;
  return { ids: selectIds(PARTS, page.where), res, page, count: calls.count };
}

describe('a system root lists its whole subtree', () => {
  it('brake-system: every subcategory, the bucket row and the root itself', async () => {
    const { ids, res } = await listing({ category: 'brake-system' });
    expect(ids).toEqual([
      'b_root',
      'b_bucket',
      'b_front',
      'b_rear',
      'b_discs',
      'b_calipers',
      'b_cylinders',
      'b_hoses',
    ]);
    expect(res.total).toBe(8);
  });

  it('suspension-and-steering: all three levels, the intermediate node included', async () => {
    const { ids, res } = await listing({ category: 'suspension-and-steering' });
    expect(ids).toEqual([
      's_root',
      's_shock',
      's_hubs',
      's_ball',
      's_roller',
      's_bucket',
    ]);
    expect(res.total).toBe(6);
  });

  it('other: the goods of every child of "Другое"', async () => {
    const { ids } = await listing({ category: 'other' });
    expect(ids).toEqual(['o_moto', 'o_fasteners', 'o_wipers']);
  });

  it('lists a part once, and an uncategorized part under no system', async () => {
    const seen: string[] = [];
    for (const category of [
      'brake-system',
      'suspension-and-steering',
      'other',
    ]) {
      const { ids, res } = await listing({ category });
      expect(new Set(ids).size).toBe(ids.length);
      expect(res.total).toBe(ids.length);
      seen.push(...ids);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain('u_none');
    expect(seen).not.toContain('b_no_photo');
  });
});

describe('other category requests keep their meaning', () => {
  it('a leaf lists exactly its own parts', async () => {
    expect((await listing({ category: 'front-brake-pads' })).ids).toEqual([
      'b_front',
    ]);
    expect((await listing({ category: 'ball-bearings' })).ids).toEqual([
      's_ball',
    ]);
  });

  it('an intermediate node lists itself and what is filed beneath it', async () => {
    expect((await listing({ category: 'wheel-hubs-bearings' })).ids).toEqual([
      's_hubs',
      's_ball',
      's_roller',
    ]);
  });

  it('a bucket slug still rolls up by main_category', async () => {
    const { ids, page } = await listing({ category: 'brakes' });
    expect(JSON.stringify(page.where)).toContain('"mainCategory":"BRAKES"');
    // Every listed BRAKES part, wherever in the tree it is filed.
    expect(ids).toEqual([
      'b_root',
      'b_bucket',
      'b_front',
      'b_rear',
      'b_discs',
      'b_calipers',
      'b_cylinders',
      'b_hoses',
    ]);
  });
});

describe('paging, sort, search and the model filter on a root listing', () => {
  it('pages and sorts over the same predicate it counts', async () => {
    const { res, page, count } = await listing({
      category: 'brake-system',
      page: 2,
      page_size: 3,
      sort: 'price_asc',
    });
    expect(page).toMatchObject({
      skip: 3,
      take: 3,
      orderBy: [{ priceUzs: 'asc' }, { id: 'asc' }],
    });
    expect(page.where).toEqual(count?.where);
    expect(res).toMatchObject({
      total: 8,
      page: 2,
      page_size: 3,
      next_page: 3,
    });
  });

  it('a search narrows the system, never widens it', async () => {
    const { ids } = await listing({
      category: 'suspension-and-steering',
      q: 'bearing',
    });
    expect(ids).toEqual(['s_ball', 's_roller']);
  });

  it('a model filter keeps the parts of the system that fit it', async () => {
    const { ids } = await listing({
      category: 'suspension-and-steering',
      make: 'Chevrolet',
      model: 'Cobalt',
    });
    expect(ids).toEqual(['s_ball']);
  });
});

/** Rows in `orderBy` order, as far as the keys decide it: a stable sort, so
 *  rows the keys tie on keep the order they arrived in — the order a database
 *  promises nothing about. Nulls sort last. */
function ordered<T extends Record<string, unknown>>(
  rows: T[],
  orderBy: Record<string, unknown>[],
): T[] {
  return [...rows].sort((a, b) => {
    for (const key of orderBy) {
      const [field, spec] = Object.entries(key)[0];
      const dir =
        typeof spec === 'string' ? spec : (spec as { sort: string }).sort;
      const x = a[field] as string | number | null | undefined;
      const y = b[field] as string | number | null | undefined;
      if (x === y) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

describe('paging a root listing repeats and drops nothing', () => {
  // Every brake part has the same price and none carries a sales signal or a
  // creation time, so each sort ties on all of its own keys.
  it.each(['relevance', 'price_asc', 'price_desc', 'bestseller'])(
    '%s: the pages partition the listing',
    async (sort) => {
      const shown: string[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const { page: query } = await listing({
          category: 'brake-system',
          sort,
          page,
          page_size: 3,
        });
        expect(query.orderBy).toContainEqual({ id: 'asc' });
        // Each page query gets the tied rows in a different order.
        const rows = PARTS.filter((p) => matchesWhere(p, query.where));
        const arrival = page % 2 ? rows : [...rows].reverse();
        shown.push(
          ...ordered(arrival, query.orderBy as Record<string, unknown>[])
            .slice(query.skip, query.skip + query.take)
            .map((p) => p.id),
        );
      }
      expect(shown).toHaveLength(8);
      expect(new Set(shown)).toEqual(
        new Set((await listing({ category: 'brake-system' })).ids),
      );
    },
  );
});
