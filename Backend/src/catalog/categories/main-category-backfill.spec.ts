// The main_category backfill (npm run backfill:root-buckets), run against an
// in-memory database that evaluates the REAL `where` clauses (where-eval), so
// "fills only NULLs" is proven on the predicate the script sends, not assumed.

import { DealerStatus, PartMainCategory as B } from '@prisma/client';
import {
  MainCategoryBackfillDb,
  applyMainCategoryBackfill,
  describeBackfillPlan,
  planMainCategoryBackfill,
} from './main-category-backfill';
import { matchesWhere } from '../compatibility/where-eval.test-util';
import { LIVE_TREE } from './seeded-category-tree.test-util';

type Row = Record<string, unknown>;

const byId = (a: Row, b: Row) =>
  String(a.id).localeCompare(String(b.id), undefined, { numeric: true });

/** One table: findMany / groupBy / updateMany over plain rows. */
function table(rows: Row[]) {
  const selected = (where: unknown) =>
    rows.filter((r) => matchesWhere(r, where));
  return {
    findMany: jest.fn(
      ({ where, select }: { where?: unknown; select?: Record<string, true> }) =>
        Promise.resolve(
          selected(where)
            .sort(byId)
            .map((r) =>
              select
                ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))
                : { ...r },
            ),
        ),
    ),
    groupBy: jest.fn(({ by, where }: { by: string[]; where?: unknown }) => {
      const groups = new Map<string, Row & { _count: { _all: number } }>();
      for (const r of selected(where)) {
        const key = JSON.stringify(by.map((k) => r[k]));
        const group = groups.get(key) ?? {
          ...Object.fromEntries(by.map((k) => [k, r[k]])),
          _count: { _all: 0 },
        };
        group._count._all += 1;
        groups.set(key, group);
      }
      return Promise.resolve([...groups.values()]);
    }),
    updateMany: jest.fn(({ where, data }: { where: unknown; data: Row }) => {
      const hit = selected(where);
      for (const r of hit) Object.assign(r, data);
      return Promise.resolve({ count: hit.length });
    }),
  };
}

const part = (
  id: string,
  categoryId: string,
  mainCategory: B | null,
  opts: { photo?: false } = {},
): Row => ({
  id,
  title: `Part ${id}`,
  categoryId,
  mainCategory,
  images: opts.photo === false ? [] : [`https://cdn/${id}.webp`],
  seller: { status: DealerStatus.ACTIVE },
});

const product = (
  id: number,
  categoryId: string | null,
  mainCategory: B | null,
): Row => ({ id, title: `Product ${id}`, categoryId, mainCategory });

function world() {
  const parts: Row[] = [
    part('part_1', 'front-brake-pads', null),
    part('part_2', 'rear-brake-pads', null),
    part('part_3', 'air-filters', null),
    part('part_4', 'air-filters', null, { photo: false }),
    part('part_5', 'air-filters', B.ENGINE), // assigned — differs from the tree
    part('part_6', 'semi-synthetic-motor-oil', B.OIL_AND_FLUIDS),
    part('part_7', 'clutch-kits', null), // no home bucket
    part('part_8', 'fuel-and-oil-pumps', null), // unreviewed node
    part('part_9', 'cat_uncategorized', null),
    part('part_10', 'spark-plugs', null),
  ];
  const products: Row[] = [
    product(1, 'front-brake-pads', null),
    product(2, 'air-filters', B.ENGINE), // assigned — differs from the tree
    product(3, 'clutch-kits', null),
    product(4, null, null), // filed on no category
    product(5, 'spark-plugs', null),
  ];
  const catalogPart = table(parts);
  const productTable = table(products);
  const db = {
    partCategory: { findMany: jest.fn(() => Promise.resolve([...LIVE_TREE])) },
    catalogPart,
    product: productTable,
  } as unknown as MainCategoryBackfillDb;
  const bucketOf = (rows: Row[], id: string | number) =>
    rows.find((r) => r.id === id)?.mainCategory;
  return { db, parts, products, catalogPart, productTable, bucketOf };
}

describe('main_category backfill — dry-run plan', () => {
  it('lists exactly the NULL rows whose category has a bucket, per bucket', async () => {
    const { db } = world();
    const plan = await planMainCategoryBackfill(db);
    expect(
      plan.fills.map((f) => ({
        bucket: f.mainCategory,
        parts: f.catalogParts.map((r) => r.id),
        products: f.products.map((r) => r.id),
      })),
    ).toEqual([
      { bucket: B.BRAKES, parts: ['part_1', 'part_2'], products: [1] },
      { bucket: B.FILTERS, parts: ['part_3', 'part_4'], products: [] },
      { bucket: B.IGNITION, parts: ['part_10'], products: [5] },
    ]);
  });

  it('writes nothing', async () => {
    const { db, catalogPart, productTable } = world();
    describeBackfillPlan(await planMainCategoryBackfill(db));
    expect(catalogPart.updateMany).not.toHaveBeenCalled();
    expect(productTable.updateMany).not.toHaveBeenCalled();
  });

  it('reports what stays unbucketed and why, unreviewed nodes first', async () => {
    const { db } = world();
    const { unbucketed } = await planMainCategoryBackfill(db);
    expect(unbucketed).toEqual([
      {
        categoryId: 'fuel-and-oil-pumps',
        reason: 'unreviewed',
        catalogParts: 1,
        listedCatalogParts: 1,
        products: 0,
      },
      {
        categoryId: 'clutch-kits',
        reason: 'no-home-bucket',
        catalogParts: 1,
        listedCatalogParts: 1,
        products: 1,
      },
      {
        categoryId: 'cat_uncategorized',
        reason: 'no-home-bucket',
        catalogParts: 1,
        listedCatalogParts: 1,
        products: 0,
      },
      {
        categoryId: null,
        reason: 'no-category',
        catalogParts: 0,
        listedCatalogParts: 0,
        products: 1,
      },
    ]);
  });

  it('reports stored buckets that differ from the tree, to be kept', async () => {
    const { db } = world();
    const { kept } = await planMainCategoryBackfill(db);
    expect(kept).toEqual([
      {
        table: 'catalog_parts',
        categoryId: 'air-filters',
        stored: B.ENGINE,
        fromTree: B.FILTERS,
        rows: 1,
      },
      {
        table: 'products',
        categoryId: 'air-filters',
        stored: B.ENGINE,
        fromTree: B.FILTERS,
        rows: 1,
      },
    ]);
  });

  it('shows every tile count now and after, counting buyer-listed parts only', async () => {
    const { db } = world();
    const { homeGrid } = await planMainCategoryBackfill(db);
    const tile = (b: B) => homeGrid.find((t) => t.mainCategory === b);
    expect(homeGrid).toHaveLength(12);
    expect(tile(B.BRAKES)).toEqual({
      mainCategory: B.BRAKES,
      now: 0,
      after: 2,
    });
    // part_4 is filled too, but has no photo, so the tile gains one part.
    expect(tile(B.FILTERS)).toEqual({
      mainCategory: B.FILTERS,
      now: 0,
      after: 1,
    });
    expect(tile(B.IGNITION)).toEqual({
      mainCategory: B.IGNITION,
      now: 0,
      after: 1,
    });
    expect(tile(B.ENGINE)).toEqual({
      mainCategory: B.ENGINE,
      now: 1,
      after: 1,
    });
    expect(tile(B.OIL_AND_FLUIDS)).toEqual({
      mainCategory: B.OIL_AND_FLUIDS,
      now: 1,
      after: 1,
    });
  });

  it('prints the rows, per-category and per-bucket counts', async () => {
    const { db } = world();
    const report = describeBackfillPlan(await planMainCategoryBackfill(db));
    const text = report.join('\n');
    expect(text).toContain('BRAKES (brakes) ← catalog_parts 2, products 1');
    expect(text).toMatch(/front-brake-pads\s+catalog_parts\s+1\s+products\s+1/);
    expect(text).toContain(
      'catalog_parts  part_1  [front-brake-pads]  Part part_1',
    );
    expect(text).toContain('products       #1  [front-brake-pads]  Product 1');
    expect(text).toMatch(/TOTAL\s+5\s+2/);
    expect(text).toMatch(/BRAKES \(brakes\)\s+0\s+2\s+\(\+2\)/);
    expect(text).toMatch(/fuel-and-oil-pumps\s+unreviewed/);
    expect(text).toMatch(/air-filters\s+ENGINE \(tree: FILTERS\)/);
  });
});

describe('main_category backfill — apply', () => {
  it('fills only NULLs and never overwrites an assigned bucket', async () => {
    const { db, parts, products, bucketOf } = world();
    const written = await applyMainCategoryBackfill(
      db,
      await planMainCategoryBackfill(db),
    );
    expect(written).toEqual([
      { mainCategory: B.BRAKES, catalogParts: 2, products: 1 },
      { mainCategory: B.FILTERS, catalogParts: 2, products: 0 },
      { mainCategory: B.IGNITION, catalogParts: 1, products: 1 },
    ]);
    expect(bucketOf(parts, 'part_1')).toBe(B.BRAKES);
    expect(bucketOf(parts, 'part_4')).toBe(B.FILTERS);
    expect(bucketOf(products, 1)).toBe(B.BRAKES);
    // Assigned buckets are kept, even where the tree says otherwise.
    expect(bucketOf(parts, 'part_5')).toBe(B.ENGINE);
    expect(bucketOf(parts, 'part_6')).toBe(B.OIL_AND_FLUIDS);
    expect(bucketOf(products, 2)).toBe(B.ENGINE);
    // No home bucket, unreviewed, uncategorized: left NULL.
    for (const id of ['part_7', 'part_8', 'part_9']) {
      expect([id, bucketOf(parts, id)]).toEqual([id, null]);
    }
    expect(bucketOf(products, 3)).toBeNull();
    expect(bucketOf(products, 4)).toBeNull();
  });

  it('is idempotent: a second run plans nothing and writes nothing', async () => {
    const { db, parts, products } = world();
    const first = await planMainCategoryBackfill(db);
    await applyMainCategoryBackfill(db, first);
    const snapshot = JSON.stringify([parts, products]);

    const second = await planMainCategoryBackfill(db);
    expect(second.fills).toEqual([]);
    expect(await applyMainCategoryBackfill(db, second)).toEqual([]);
    // Even replaying the first plan writes nothing: its rows are no longer NULL.
    expect(await applyMainCategoryBackfill(db, first)).toEqual([
      { mainCategory: B.BRAKES, catalogParts: 0, products: 0 },
      { mainCategory: B.FILTERS, catalogParts: 0, products: 0 },
      { mainCategory: B.IGNITION, catalogParts: 0, products: 0 },
    ]);
    expect(JSON.stringify([parts, products])).toBe(snapshot);
  });

  it('skips a row bucketed or moved after the plan was read', async () => {
    const { db, parts, bucketOf } = world();
    const plan = await planMainCategoryBackfill(db);
    // Meanwhile an operator buckets part_1 and moves part_2 to a filter node.
    Object.assign(
      parts.find((r) => r.id === 'part_1')!,
      {
        mainCategory: B.SUSPENSION,
      },
    );
    Object.assign(
      parts.find((r) => r.id === 'part_2')!,
      {
        categoryId: 'air-filters',
      },
    );

    const written = await applyMainCategoryBackfill(db, plan);
    expect(written[0]).toEqual({
      mainCategory: B.BRAKES,
      catalogParts: 0,
      products: 1,
    });
    expect(bucketOf(parts, 'part_1')).toBe(B.SUSPENSION);
    expect(bucketOf(parts, 'part_2')).toBeNull();
  });

  it('writes a large fill in bounded chunks', async () => {
    const { db, parts, catalogPart } = world();
    parts.length = 0;
    for (let i = 0; i < 1200; i += 1) {
      parts.push(part(`bulk_${i}`, 'air-filters', null));
    }
    const written = await applyMainCategoryBackfill(
      db,
      await planMainCategoryBackfill(db),
    );
    expect(written).toContainEqual({
      mainCategory: B.FILTERS,
      catalogParts: 1200,
      products: 0,
    });
    const sizes = catalogPart.updateMany.mock.calls.map(
      ([args]) => (args.where as { id: { in: string[] } }).id.in.length,
    );
    expect(sizes).toEqual([500, 500, 200]);
  });
});
