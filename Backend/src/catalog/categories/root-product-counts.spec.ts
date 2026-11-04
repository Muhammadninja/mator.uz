// The parts count under each home-grid tile, served on every root of
// GET /v1/reference/categories as `productsCount`. Counted over production's
// category tree (LIVE_TREE, plus the bearings level and the deactivated `rul`
// it lacks) and over parts the real buyer-visibility predicate runs on, then
// held against what GET /v1/catalog/parts?category=<root> lists for the same
// parts — the listing's own predicate, run by where-eval.

import { PartMainCategory, PartVehicleCategory } from '@prisma/client';
import { RedisKeys } from '../../redis/redis.keys';
import { BUYER_LISTED_PART } from '../buyer-visibility';
import * as fx from '../compatibility/fitment-fixtures.test-util';
import { matchesWhere } from '../compatibility/where-eval.test-util';
import { PartsService } from '../parts/parts.service';
import { categoryParentMap, vehicleCategoryForCategory } from './category-map';
import {
  MAX_DEPTH,
  PartCategoryService,
  catalogRootProductCounts,
  type CountedNode,
} from './part-category.service';
import { LIVE_TREE } from './seeded-category-tree.test-util';

const ROOTS = [
  'brake-system',
  'motor-oil',
  'electrical-and-lighting',
  'tuning-and-accessories',
  'transmission',
  'maintenance-and-fluids',
  'suspension-and-steering',
  'engine-system',
  'heating-and-cooling',
  'other',
];

const EDGES = [
  ...LIVE_TREE,
  { id: 'ball-bearings', parentId: 'wheel-hubs-bearings' },
  { id: 'roller-bearings', parentId: 'wheel-hubs-bearings' },
  { id: 'rul', parentId: 'suspension-and-steering' },
];
const PARENT = categoryParentMap(EDGES);
const depthOf = (id: string): number => {
  const parent = PARENT.get(id);
  return parent ? depthOf(parent) + 1 : 0;
};
/** The rows as the table holds them: `cat_uncategorized` is parentless but
 *  parked at level 1, and `rul` is deactivated. */
const NODES: CountedNode[] = EDGES.map((e) => ({
  id: e.id,
  parentId: e.parentId,
  level: e.id === 'cat_uncategorized' ? 1 : depthOf(e.id),
  isActive: e.id !== 'rul',
}));

/** A category as Prisma resolves `category.parent.parent…`. */
function node(id: string): Record<string, unknown> {
  const parentId = PARENT.get(id) ?? null;
  return { id, parentId, parent: parentId ? node(parentId) : null };
}

/** A part filed on `categoryId`, classified the way the tree pick writes it. */
function filed(
  id: string,
  categoryId: string,
  over: Partial<Parameters<typeof fx.part>[0]> = {},
) {
  return {
    ...fx.part({ id, ...over }),
    title: id,
    priceUzs: 100_000,
    categoryId,
    category: node(categoryId),
    mainCategory: null as PartMainCategory | null,
    vehicleCategory: vehicleCategoryForCategory(categoryId, PARENT),
  };
}

const many = (n: number, prefix: string, categoryId: string) =>
  Array.from({ length: n }, (_, i) => filed(`${prefix}_${i}`, categoryId));

const PARTS = [
  filed('b_root', 'brake-system'),
  filed('b_front', 'front-brake-pads'),
  filed('b_bucket', 'brakes'), // a home-grid bucket row, a child like any other
  filed('b_no_photo', 'front-brake-pads', { images: [] }),
  filed('b_suspended', 'brake-discs', { sellerStatus: 'SUSPENDED' }),

  filed('s_root', 'suspension-and-steering'),
  filed('s_springs', 'springs-and-mounts'),
  filed('s_shock', 'shock-absorbers'),
  filed('s_hubs', 'wheel-hubs-bearings'),
  filed('s_ball', 'ball-bearings'),
  filed('s_roller', 'roller-bearings'),

  filed('m_synthetic', 'synthetic-motor-oil'),
  filed('m_mineral', 'mineral-motor-oil'),
  filed('t_flywheel', 'flywheels'),
  filed('a_rims', 'wheel-rims'),
  filed('o_moto', 'motorcycle-oil'),
  filed('o_fasteners', 'fasteners-and-clips'),
  filed('o_wipers', 'wiper-blades'),
  // More than one page of the listing (24).
  ...many(30, 'e_alt', 'alternators'),
];
const ON_RUL = filed('s_rul', 'rul');
const UNCATEGORIZED = filed('u_none', 'cat_uncategorized');
const ALL_PARTS = [...PARTS, ON_RUL, UNCATEGORIZED];

/** Prisma double: the tree read returns `nodes`; the group-by runs its real
 *  `where` over `parts`. */
function countingDb(parts = ALL_PARTS, nodes = NODES) {
  return {
    partCategory: { findMany: jest.fn(() => Promise.resolve(nodes)) },
    catalogPart: {
      groupBy: jest.fn(({ where }: { where: unknown }) => {
        const counts = new Map<string, number>();
        for (const p of parts.filter((x) => matchesWhere(x, where))) {
          counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
        }
        return Promise.resolve(
          [...counts].map(([categoryId, n]) => ({
            categoryId,
            _count: { _all: n },
          })),
        );
      }),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };
}

/** A cache that keeps what it is given, as Redis would. */
function memoryCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    remember: jest.fn(
      async (key: string, _ttl: number, loader: () => Promise<unknown>) => {
        if (!store.has(key)) store.set(key, await loader());
        return store.get(key);
      },
    ),
    delete: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
  };
}

async function countsOf(parts = ALL_PARTS, nodes = NODES) {
  const tree = new PartCategoryService(
    countingDb(parts, nodes) as never,
    memoryCache() as never,
  );
  return tree.findCatalogRootProductCounts();
}

/** What GET /v1/catalog/parts?category=<root> answers over `parts`. */
async function listingTotal(category: string, parts = ALL_PARTS) {
  const prisma = {
    catalogPart: {
      count: jest.fn(({ where }: { where: unknown }) =>
        Promise.resolve(parts.filter((p) => matchesWhere(p, where)).length),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _min: {}, _max: {} }),
    },
    partBrand: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const discounts = { loadActiveSales: jest.fn().mockResolvedValue([]) };
  const res = await new PartsService(prisma as never, discounts as never).list({
    category,
    page: 1,
    page_size: 24,
  });
  return res.total;
}

describe('the count under each root', () => {
  it('is served for all 10 roots, "other" included, 0 where nothing is filed', async () => {
    const counts = await countsOf();
    expect(Object.keys(counts).sort()).toEqual([...ROOTS].sort());
    expect(counts['heating-and-cooling']).toBe(0);
    expect(counts.other).toBe(3);
  });

  it('counts the root itself and every level beneath it', async () => {
    const counts = await countsOf();
    // root, springs, shocks, wheel-hubs-bearings, ball and roller bearings
    expect(counts['suspension-and-steering']).toBe(6);
    // root, front pads, the bucket row
    expect(counts['brake-system']).toBe(3);
    expect(counts['motor-oil']).toBe(2);
  });

  it('reaches the bearings through wheel-hubs-bearings', async () => {
    const bearings = PARTS.filter((p) =>
      ['wheel-hubs-bearings', 'ball-bearings', 'roller-bearings'].includes(
        p.categoryId,
      ),
    );
    expect((await countsOf(bearings))['suspension-and-steering']).toBe(3);
  });

  it('counts each part once', async () => {
    const counts = await countsOf();
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    // Every listed part on the public tree, and nothing else.
    expect(sum).toBe(
      PARTS.filter((p) => matchesWhere(p, BUYER_LISTED_PART)).length,
    );
  });

  it('leaves out cat_uncategorized and the deactivated rul', async () => {
    expect(await countsOf([UNCATEGORIZED, ON_RUL])).toEqual(
      Object.fromEntries(ROOTS.map((r) => [r, 0])),
    );
  });

  it('leaves out what the catalog does not list: no ready photo, a suspended dealer', async () => {
    const counts = await countsOf(PARTS.filter((p) => p.id.startsWith('b_')));
    expect(counts['brake-system']).toBe(3);
  });

  it('is the whole result, not a page of it', async () => {
    expect((await countsOf())['electrical-and-lighting']).toBe(30);
  });
});

describe('the count against the root listing', () => {
  it.each(ROOTS)('%s: equals the listing total', async (root) => {
    const counts = await countsOf(PARTS);
    expect(counts[root]).toBe(await listingTotal(root, PARTS));
  });

  it('differs only by what the listing still reaches through a deactivated node', async () => {
    const counts = await countsOf();
    expect(await listingTotal('suspension-and-steering')).toBe(
      counts['suspension-and-steering'] + 1,
    );
  });

  it('follows the tree for transmission, whose listing goes by vehicle_category', async () => {
    // 'transmission' is also a PartVehicleCategory value, so its listing
    // filters on that column; the two agree while a part's vehicle_category
    // matches its place in the tree.
    const misfiled = {
      ...filed('t_engine', 'flywheels'),
      vehicleCategory: PartVehicleCategory.ENGINE,
    };
    const counts = await countsOf([...PARTS, misfiled]);
    expect(counts.transmission).toBe(2);
    expect(await listingTotal('transmission', [...PARTS, misfiled])).toBe(1);
  });
});

describe('the rule itself', () => {
  const chain = (depth: number): CountedNode[] =>
    Array.from({ length: depth + 1 }, (_, d) => ({
      id: `d${d}`,
      parentId: d === 0 ? null : `d${d - 1}`,
      level: d,
      isActive: true,
    }));

  it('reaches as deep as the listing does, and no deeper', () => {
    const counts = catalogRootProductCounts(chain(MAX_DEPTH + 1), [
      [`d${MAX_DEPTH}`, 1],
      [`d${MAX_DEPTH + 1}`, 1],
    ]);
    expect(counts).toEqual({ d0: 1 });
  });

  it('hides everything beneath a deactivated node', () => {
    const nodes = chain(3).map((n) =>
      n.id === 'd1' ? { ...n, isActive: false } : n,
    );
    expect(
      catalogRootProductCounts(nodes, [
        ['d1', 1],
        ['d3', 1],
      ]),
    ).toEqual({ d0: 0 });
  });

  it('serves no count for a deactivated root and survives a cycle or an unknown id', () => {
    const nodes: CountedNode[] = [
      { id: 'off', parentId: null, level: 0, isActive: false },
      { id: 'a', parentId: 'b', level: 1, isActive: true },
      { id: 'b', parentId: 'a', level: 1, isActive: true },
    ];
    expect(
      catalogRootProductCounts(nodes, [
        ['off', 1],
        ['a', 1],
        ['ghost', 1],
      ]),
    ).toEqual({});
  });
});

describe('reading and caching the counts', () => {
  it('runs one group-by and one tree read, and loads no part', async () => {
    const db = countingDb();
    const tree = new PartCategoryService(db as never, memoryCache() as never);
    await tree.findCatalogRootProductCounts();
    expect(db.partCategory.findMany).toHaveBeenCalledTimes(1);
    expect(db.catalogPart.groupBy).toHaveBeenCalledTimes(1);
    expect(db.catalogPart.groupBy).toHaveBeenCalledWith({
      by: ['categoryId'],
      where: BUYER_LISTED_PART,
      _count: { _all: true },
    });
    expect(db.catalogPart.findMany).not.toHaveBeenCalled();
    expect(db.catalogPart.count).not.toHaveBeenCalled();
  });

  it('keeps them for 60 s under their own key, apart from the roots', async () => {
    const cache = memoryCache();
    const tree = new PartCategoryService(countingDb() as never, cache as never);
    await tree.findCatalogRootProductCounts();
    expect(cache.remember).toHaveBeenCalledWith(
      RedisKeys.cacheReferenceCategoryCounts(),
      60,
      expect.any(Function),
    );
    expect(RedisKeys.cacheReferenceCategoryCounts()).not.toBe(
      RedisKeys.cacheReferenceCategories(),
    );
  });

  it('serves the cached counts until the TTL, or a taxonomy edit, drops them', async () => {
    const parts = [...PARTS];
    const cache = memoryCache();
    const tree = new PartCategoryService(
      countingDb(parts) as never,
      cache as never,
    );
    expect(
      (await tree.findCatalogRootProductCounts())['heating-and-cooling'],
    ).toBe(0);

    parts.push(filed('h_radiator', 'cooling-radiators'));
    expect(
      (await tree.findCatalogRootProductCounts())['heating-and-cooling'],
    ).toBe(0);

    // The admin console's writes all end in invalidate(); expiry is the same
    // delete, done by Redis.
    await tree.invalidate();
    expect(
      (await tree.findCatalogRootProductCounts())['heating-and-cooling'],
    ).toBe(1);
  });
});
