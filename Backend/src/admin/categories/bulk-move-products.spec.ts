// Moving parts between categories from the admin console — PATCH
// /v1/admin/products/bulk-move and DELETE /v1/admin/categories/:id?reassignTo=.
//
// The home grid counts AND lists by catalog_parts.main_category, so a move that
// rewrote category_id alone left a part on its old tile. These tests pin that a
// move re-derives the bucket and the vehicle system from the target's place in
// the live tree (by id, never by name), writes nothing else of the part, and —
// end to end through the real CategoriesService / PartsService predicates —
// that the part then counts and lists under the tile of its new category.

import { NotFoundException } from '@nestjs/common';
import {
  DealerStatus,
  PartMainCategory as B,
  PartVehicleCategory as V,
} from '@prisma/client';
import { AdminCategoriesService } from './admin-categories.service';
import { CategoriesService } from '../../catalog/categories/categories.service';
import { MAIN_CATEGORIES } from '../../catalog/categories/part-categories.catalog';
import {
  LIVE_TREE,
  type TreeRow,
} from '../../catalog/categories/seeded-category-tree.test-util';
import { matchesWhere } from '../../catalog/compatibility/where-eval.test-util';
import { PartsService } from '../../catalog/parts/parts.service';

type PartRow = {
  id: string;
  title: string;
  categoryId: string;
  mainCategory: B | null;
  vehicleCategory: V | null;
  priceUzs: number;
  stockQty: number;
  inStock: boolean;
  images: string[];
  oemNumbers: string[];
  isUniversal: boolean;
  cashbackPct: number;
  seller: { status: DealerStatus };
};

const part = (
  id: string,
  categoryId: string,
  mainCategory: B | null,
  vehicleCategory: V | null,
): PartRow => ({
  id,
  title: `Part ${id}`,
  categoryId,
  mainCategory,
  vehicleCategory,
  priceUzs: 185_000,
  stockQty: 4,
  inStock: true,
  images: [`https://cdn/${id}.webp`],
  oemNumbers: [`OEM-${id}`],
  isUniversal: false,
  cashbackPct: 2,
  seller: { status: DealerStatus.ACTIVE },
});

/**
 * The admin service over an in-memory tree and catalog_parts table: updateMany
 * applies `data` to the rows its real `where` selects, so the catalog reads
 * below see exactly what the move wrote.
 */
function adminWorld(rows: PartRow[], tree: readonly TreeRow[] = LIVE_TREE) {
  const prisma = {
    partCategory: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(tree.find((n) => n.id === where.id) ?? null),
      ),
      findMany: jest.fn(() => Promise.resolve(tree.map((n) => ({ ...n })))),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({}),
    },
    product: { count: jest.fn().mockResolvedValue(0) },
    productDraft: { count: jest.fn().mockResolvedValue(0) },
    catalogPart: {
      count: jest.fn(({ where }: { where: unknown }) =>
        Promise.resolve(rows.filter((r) => matchesWhere(r, where)).length),
      ),
      updateMany: jest.fn(
        ({ where, data }: { where: unknown; data: Partial<PartRow> }) => {
          const hit = rows.filter((r) => matchesWhere(r, where));
          for (const r of hit) Object.assign(r, data);
          return Promise.resolve({ count: hit.length });
        },
      ),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const categories = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminCategoriesService(
    prisma as never,
    categories as never,
  );
  return { service, prisma };
}

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

/** The buyer catalog (home grid + listing) reading the same rows live. */
function catalog(rows: PartRow[]) {
  const selected = (where: unknown) =>
    rows.filter((r) => matchesWhere(r, where));
  const prisma = {
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
        for (const r of selected(where)) {
          counts.set(r.mainCategory, (counts.get(r.mainCategory) ?? 0) + 1);
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
  const grid = new CategoriesService(prisma as never);
  const parts = new PartsService(prisma as never, NO_DISCOUNTS as never);
  return {
    async tiles(): Promise<Record<string, number>> {
      const { items } = (await grid.list({}, 'ru', null)) as {
        items: { id: string; count: number }[];
      };
      return Object.fromEntries(items.map((t) => [t.id, t.count]));
    },
    async listed(category: string): Promise<number> {
      return (await parts.list({ category }, 'ru', null)).total;
    },
  };
}

const CLASSIFICATION = ['categoryId', 'mainCategory', 'vehicleCategory'];
const unrelated = (r: PartRow) =>
  Object.fromEntries(
    Object.entries(r).filter(([k]) => !CLASSIFICATION.includes(k)),
  );

describe('bulk-move — the filing a move writes', () => {
  const move = async (
    targetCategoryId: string,
    tree: readonly TreeRow[] = LIVE_TREE,
  ) => {
    const rows = [part('p1', 'front-brake-pads', B.BRAKES, V.BRAKE_SYSTEM)];
    const { service } = adminWorld(rows, tree);
    const res = await service.bulkMoveProducts({
      productIds: ['p1'],
      targetCategoryId,
    });
    return { row: rows[0], data: res.data };
  };

  it.each([
    // between two home-grid categories (bucket rows)
    ['filters', B.FILTERS, V.MAINTENANCE_AND_FLUIDS],
    // between subcategories of one category
    ['rear-brake-pads', B.BRAKES, V.BRAKE_SYSTEM],
    // between subcategories of different categories
    ['air-filters', B.FILTERS, V.MAINTENANCE_AND_FLUIDS],
    ['spark-plugs', B.IGNITION, V.ELECTRICAL_AND_LIGHTING],
    ['timing-belt-kits', B.BELTS_AND_HOSES, V.ENGINE],
    // admin-created in production: bucket from its own rule, system from root
    ['tire-pressure-sensors', B.ELECTRICAL_PARTS, V.ELECTRICAL_AND_LIGHTING],
    // filed under "Другое" in production: a bucket, but no vehicle system
    ['wiper-blades', B.WIPERS, null],
    ['synthetic-motor-oil', B.OIL_AND_FLUIDS, null],
    // no home bucket among the 12: on no tile, still its system
    ['clutch-kits', null, V.TRANSMISSION],
    ['fuel-and-oil-pumps', null, V.ENGINE],
    ['cat_uncategorized', null, null],
  ])('→ %s: mainCategory %s, vehicleCategory %s', async (target, main, veh) => {
    const { row, data } = await move(target);
    expect(row).toMatchObject({
      categoryId: target,
      mainCategory: main,
      vehicleCategory: veh,
    });
    expect(data).toEqual({
      moved: 1,
      categoryId: target,
      mainCategory: main,
      vehicleCategory: veh,
    });
  });

  it('derives the parent from the tree structure, not from a name or a stored bucket', async () => {
    // An admin-created node no rule names: its bucket and system come from
    // wherever it hangs NOW.
    const under = (parentId: string) => [
      ...LIVE_TREE,
      { id: 'brake-boosters', parentId },
    ];
    expect(
      (await move('brake-boosters', under('brake-system'))).row,
    ).toMatchObject({
      mainCategory: B.BRAKES,
      vehicleCategory: V.BRAKE_SYSTEM,
    });
    expect(
      (await move('brake-boosters', under('suspension-and-steering'))).row,
    ).toMatchObject({
      mainCategory: B.SUSPENSION,
      vehicleCategory: V.SUSPENSION_AND_STEERING,
    });
  });

  it('writes ONLY the three classification columns — price, stock, photos, numbers stay', async () => {
    const rows = [part('p1', 'front-brake-pads', B.BRAKES, V.BRAKE_SYSTEM)];
    const before = unrelated({ ...rows[0] });
    const { service, prisma } = adminWorld(rows);

    await service.bulkMoveProducts({
      productIds: ['p1'],
      targetCategoryId: 'air-filters',
    });

    const { data } = prisma.catalogPart.updateMany.mock.calls[0][0];
    expect(Object.keys(data).sort()).toEqual([...CLASSIFICATION].sort());
    expect(unrelated(rows[0])).toEqual(before);
  });

  it('moves only the listed parts', async () => {
    const rows = [
      part('p1', 'front-brake-pads', B.BRAKES, V.BRAKE_SYSTEM),
      part('p2', 'front-brake-pads', B.BRAKES, V.BRAKE_SYSTEM),
    ];
    const { service } = adminWorld(rows);
    const res = await service.bulkMoveProducts({
      productIds: ['p1', 'no-such-part'],
      targetCategoryId: 'air-filters',
    });
    expect(res.data.moved).toBe(1);
    expect(rows[1]).toMatchObject({
      categoryId: 'front-brake-pads',
      mainCategory: B.BRAKES,
    });
  });

  it('404s on an unknown target and writes nothing', async () => {
    const rows = [part('p1', 'front-brake-pads', B.BRAKES, V.BRAKE_SYSTEM)];
    const before = { ...rows[0] };
    const { service, prisma } = adminWorld(rows);

    await expect(
      service.bulkMoveProducts({
        productIds: ['p1'],
        targetCategoryId: 'no-such-category',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.catalogPart.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(rows[0]).toEqual(before);
  });
});

describe('bulk-move — the part shows on the tile of its new category', () => {
  it('counts and lists every moved part under its new tile, none under the old', async () => {
    const rows = [
      part('p1', 'brakes', B.BRAKES, V.BRAKE_SYSTEM), // → another main category
      part('p2', 'front-brake-pads', B.BRAKES, V.BRAKE_SYSTEM), // → same category
      part('p3', 'front-brake-pads', B.BRAKES, V.BRAKE_SYSTEM), // → other category
      // A classifier's guess for its old filing must not follow it.
      part('p4', 'cat_uncategorized', B.ENGINE, null), // → no home bucket
      part('p5', 'shock-absorbers', B.SUSPENSION, V.SUSPENSION_AND_STEERING),
    ];
    const { service } = adminWorld(rows);
    const buyer = catalog(rows);

    expect(await buyer.tiles()).toMatchObject({
      brakes: 3,
      filters: 0,
      engine: 1,
      suspension: 1,
    });

    for (const [ids, target] of [
      [['p1'], 'filters'],
      [['p2'], 'rear-brake-pads'],
      [['p3'], 'air-filters'],
      [['p4'], 'clutch-kits'],
    ] as const) {
      await service.bulkMoveProducts({
        productIds: [...ids],
        targetCategoryId: target,
      });
    }

    const tiles = await buyer.tiles();
    expect(tiles).toMatchObject({
      brakes: 1,
      filters: 2,
      engine: 0,
      suspension: 1,
    });
    // Tapping a tile lists exactly what it counts.
    for (const tile of ['brakes', 'filters', 'engine', 'suspension']) {
      expect({ tile, listed: await buyer.listed(tile) }).toEqual({
        tile,
        listed: tiles[tile],
      });
    }
    // Each part is reachable by its new category, and no longer by its old one.
    expect(await buyer.listed('rear-brake-pads')).toBe(1);
    expect(await buyer.listed('air-filters')).toBe(1);
    expect(await buyer.listed('clutch-kits')).toBe(1);
    expect(await buyer.listed('front-brake-pads')).toBe(0);
    // A part with no home bucket is on no tile at all.
    expect(Object.values(tiles).reduce((n, c) => n + c, 0)).toBe(4);
  });
});

describe('category delete with ?reassignTo= — the same move', () => {
  it('re-buckets the reassigned parts before deleting the category', async () => {
    const tree = [...LIVE_TREE, { id: 'old-pads', parentId: 'brake-system' }];
    const rows = [
      part('p1', 'old-pads', B.BRAKES, V.BRAKE_SYSTEM),
      part('p2', 'old-pads', B.BRAKES, V.BRAKE_SYSTEM),
    ];
    const before = rows.map((r) => unrelated({ ...r }));
    const { service, prisma } = adminWorld(rows, tree);

    const res = await service.remove('old-pads', 'air-filters');

    expect(res.data).toEqual({ deleted: 'old-pads', reassigned: 2 });
    for (const r of rows) {
      expect(r).toMatchObject({
        categoryId: 'air-filters',
        mainCategory: B.FILTERS,
        vehicleCategory: V.MAINTENANCE_AND_FLUIDS,
      });
    }
    expect(rows.map(unrelated)).toEqual(before);
    expect(prisma.partCategory.delete).toHaveBeenCalledWith({
      where: { id: 'old-pads' },
    });
  });

  it('404s on an unknown reassign target and moves nothing', async () => {
    const tree = [...LIVE_TREE, { id: 'old-pads', parentId: 'brake-system' }];
    const rows = [part('p1', 'old-pads', B.BRAKES, V.BRAKE_SYSTEM)];
    const { service, prisma } = adminWorld(rows, tree);

    await expect(
      service.remove('old-pads', 'no-such-category'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.catalogPart.updateMany).not.toHaveBeenCalled();
    expect(prisma.partCategory.delete).not.toHaveBeenCalled();
  });
});
