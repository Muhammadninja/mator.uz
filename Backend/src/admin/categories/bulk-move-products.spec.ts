// Moving parts between categories from the admin console — PATCH
// /v1/admin/products/bulk-move and DELETE /v1/admin/categories/:id?reassignTo=.
//
// The home grid counts AND lists by catalog_parts.main_category, so a move that
// rewrote category_id alone left a part on its old tile. These tests pin that a
// move re-derives the bucket and the vehicle system from the target's place in
// the live tree (by id, never by name), writes nothing else of the part, and —
// end to end through the real CategoriesService / PartsService predicates —
// that the part then counts and lists under the tile of its new category.

import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  AdminAuditAction,
  DealerStatus,
  OilType,
  PartMainCategory as B,
  PartVehicleCategory as V,
  ProductKind,
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
  kind: ProductKind;
  oilType: OilType | null;
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
  kind: ProductKind.SPARE_PART,
  oilType: null,
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
    sale: { findMany: jest.fn().mockResolvedValue([]) },
    catalogPart: {
      // Copies, as Prisma returns: what was read must not change under the reader.
      findMany: jest.fn(({ where }: { where: unknown }) =>
        Promise.resolve(
          rows.filter((r) => matchesWhere(r, where)).map((r) => ({ ...r })),
        ),
      ),
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
    // The row lock in remove(), with the category it deletes present.
    $queryRaw: jest.fn().mockResolvedValue([{ parent_id: 'brake-system' }]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn((arg: unknown): unknown =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prisma)
        : Promise.all(arg as unknown[]),
    ),
  };
  const categories = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    recordMany: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AdminCategoriesService(
    prisma as never,
    categories as never,
    audit as never,
  );
  return { service, prisma, audit };
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

// A move decides what a part's receipt says: its category supplies the code. So it
// may not leave a contradiction behind, and may not change a kind unless told to.
describe('bulk-move — kind and oil type', () => {
  const oil = (id: string, categoryId: string, oilType: OilType | null) => ({
    ...part(id, categoryId, B.OIL_AND_FLUIDS, null),
    kind: ProductKind.MOTOR_OIL,
    oilType,
  });

  it('a motor oil re-filed between compositions takes the new type, on its new tile', async () => {
    const rows = [oil('p1', 'mineral-motor-oil', OilType.MINERAL)];
    const { service, audit } = adminWorld(rows);

    const res = await service.bulkMoveProducts({
      productIds: ['p1'],
      targetCategoryId: 'synthetic-motor-oil',
    });

    expect(rows[0]).toMatchObject({
      categoryId: 'synthetic-motor-oil',
      mainCategory: B.OIL_AND_FLUIDS,
      vehicleCategory: null,
      kind: ProductKind.MOTOR_OIL,
      oilType: OilType.SYNTHETIC,
    });
    expect(res.data.moved).toBe(1);
    // On the record, or nobody could later tell why its MXIK changed.
    expect(audit.recordMany.mock.calls[0][0][0]).toMatchObject({
      action: AdminAuditAction.CATALOG_PART_MOVED,
      previousValues: {
        categoryId: 'mineral-motor-oil',
        oilType: OilType.MINERAL,
      },
      newValues: {
        categoryId: 'synthetic-motor-oil',
        oilType: OilType.SYNTHETIC,
      },
    });
  });

  it('transmission oil denotes no composition, so the old type goes', async () => {
    const rows = [oil('p1', 'synthetic-motor-oil', OilType.SYNTHETIC)];
    const { service } = adminWorld(rows);

    await service.bulkMoveProducts({
      productIds: ['p1'],
      targetCategoryId: 'transmission-oil',
    });

    expect(rows[0]).toMatchObject({
      categoryId: 'transmission-oil',
      oilType: null,
    });
  });

  const refused = async (
    rows: PartRow[],
    targetCategoryId: string,
    code: string,
  ) => {
    const before = rows.map((r) => ({ ...r }));
    const { service, prisma, audit } = adminWorld(rows);
    const error = await service
      .bulkMoveProducts({ productIds: rows.map((r) => r.id), targetCategoryId })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code });
    expect(prisma.catalogPart.updateMany).not.toHaveBeenCalled();
    expect(audit.recordMany).not.toHaveBeenCalled();
    expect(rows).toEqual(before);
  };

  it('a spare part cannot go onto a composition: a move never changes a kind', () =>
    refused(
      [part('p1', 'front-brake-pads', B.BRAKES, V.BRAKE_SYSTEM)],
      'synthetic-motor-oil',
      'KIND_MISMATCH',
    ));

  it('nor a motor oil onto a brake category', () =>
    refused(
      [oil('p1', 'mineral-motor-oil', OilType.MINERAL)],
      'front-brake-pads',
      'KIND_MISMATCH',
    ));

  it('a type the seller stated elsewhere stops a move onto another composition', () =>
    refused(
      [oil('p1', 'oil-and-fluids', OilType.MINERAL)],
      'synthetic-motor-oil',
      'OIL_TYPE_CONFLICT',
    ));

  it('the `motor-oil` parent cannot say which composition an oil is', () =>
    refused(
      [oil('p1', 'mineral-motor-oil', OilType.MINERAL)],
      'motor-oil',
      'OIL_COMPOSITION_REQUIRED',
    ));

  it('one part that cannot go stops the batch: no half-done move', () =>
    refused(
      [
        oil('p1', 'mineral-motor-oil', OilType.MINERAL),
        part('p2', 'front-brake-pads', B.BRAKES, V.BRAKE_SYSTEM),
      ],
      'synthetic-motor-oil',
      'KIND_MISMATCH',
    ));

  describe('with the kind stated explicitly', () => {
    it('types a mis-typed oil, and the audit trail says so', async () => {
      // A Driver’s Village oil filed by hand before typing existed: only an operator
      // can say what it really is, and this is where they say it.
      const rows = [part('p1', 'oil-and-fluids', B.OIL_AND_FLUIDS, null)];
      const { service, audit } = adminWorld(rows);

      await service.bulkMoveProducts({
        productIds: ['p1'],
        targetCategoryId: 'synthetic-motor-oil',
        kind: ProductKind.MOTOR_OIL,
      });

      expect(rows[0]).toMatchObject({
        categoryId: 'synthetic-motor-oil',
        kind: ProductKind.MOTOR_OIL,
        oilType: OilType.SYNTHETIC,
      });
      expect(audit.recordMany.mock.calls[0][0][0]).toMatchObject({
        previousValues: { kind: ProductKind.SPARE_PART, oilType: null },
        newValues: {
          kind: ProductKind.MOTOR_OIL,
          oilType: OilType.SYNTHETIC,
        },
      });
    });

    it('calling an oil a spare part drops its oil type', async () => {
      const rows = [oil('p1', 'mineral-motor-oil', OilType.MINERAL)];
      const { service } = adminWorld(rows);

      await service.bulkMoveProducts({
        productIds: ['p1'],
        targetCategoryId: 'front-brake-pads',
        kind: ProductKind.SPARE_PART,
      });

      expect(rows[0]).toMatchObject({
        categoryId: 'front-brake-pads',
        kind: ProductKind.SPARE_PART,
        oilType: null,
      });
    });

    it('a stated kind still has to fit the target', async () => {
      const rows = [part('p1', 'front-brake-pads', B.BRAKES, V.BRAKE_SYSTEM)];
      const { service } = adminWorld(rows);

      await expect(
        service.bulkMoveProducts({
          productIds: ['p1'],
          targetCategoryId: 'air-filters',
          kind: ProductKind.MOTOR_OIL,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
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
