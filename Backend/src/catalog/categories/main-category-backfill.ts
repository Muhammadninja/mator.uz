import { PartMainCategory, PrismaClient } from '@prisma/client';
import { buyerListed } from '../buyer-visibility';
import {
  CATEGORIES_WITHOUT_MAIN_CATEGORY,
  MAIN_CATEGORY_TO_SLUG,
  categoryParentMap,
  mainCategoryForCategory,
} from './category-map';

/**
 * Backfill of the home-grid bucket (`main_category`) for rows nothing ever
 * bucketed, on BOTH sides — `products` (the supply source the projection reads
 * first) and `catalog_parts` (the buyer read model the grid counts and lists).
 * It applies the exact rule the projection uses for new rows
 * (mainCategoryForCategory), so the two can never disagree.
 *
 * Planning only reads. Applying fills NULLs only: a row that already carries a
 * bucket — the Telegram classifier's, an operator's, an earlier run's — is never
 * written, which also makes a re-run a no-op. Driven by
 * `npm run backfill:root-buckets` (prisma/backfill-root-buckets.ts).
 */

/** The Prisma delegates the backfill reads and writes. */
export type MainCategoryBackfillDb = Pick<
  PrismaClient,
  'partCategory' | 'catalogPart' | 'product'
>;

/** One row the plan would fill, as the dry-run lists it. */
export interface PlannedRow<Id extends string | number> {
  id: Id;
  title: string;
  categoryId: string;
}

/** Every row one bucket would receive. */
export interface BucketFill {
  mainCategory: PartMainCategory;
  catalogParts: PlannedRow<string>[];
  products: PlannedRow<number>[];
}

/**
 * Why rows keep `main_category = NULL`:
 *   no-home-bucket — the node is listed in CATEGORIES_WITHOUT_MAIN_CATEGORY
 *                    (decided: no bucket among the 12);
 *   unreviewed     — no rule decides the node itself (e.g. a category an admin
 *                    created) — it needs a decision;
 *   no-category    — a product filed on no category at all.
 */
export type UnbucketedReason = 'no-home-bucket' | 'unreviewed' | 'no-category';

export interface UnbucketedCategory {
  categoryId: string | null;
  reason: UnbucketedReason;
  catalogParts: number;
  /** Of those, the parts a buyer can see (photo + dealer gate). */
  listedCatalogParts: number;
  products: number;
}

/** Rows whose stored bucket differs from the tree's — kept, never written. */
export interface KeptBucket {
  table: 'catalog_parts' | 'products';
  categoryId: string;
  stored: PartMainCategory;
  fromTree: PartMainCategory;
  rows: number;
}

/** A home-grid tile's count (buyer-listed parts, no vehicle scope). */
export interface HomeGridTile {
  mainCategory: PartMainCategory;
  now: number;
  /** Once this plan is applied, nothing else changing meanwhile. */
  after: number;
}

export interface MainCategoryBackfillPlan {
  fills: BucketFill[];
  unbucketed: UnbucketedCategory[];
  kept: KeptBucket[];
  homeGrid: HomeGridTile[];
}

export interface BucketFillResult {
  mainCategory: PartMainCategory;
  catalogParts: number;
  products: number;
}

const BUCKETS = Object.values(PartMainCategory);

/** Ids per updateMany, so a large fill never builds one huge IN list. */
const WRITE_CHUNK = 500;

const REASON_ORDER: Record<UnbucketedReason, number> = {
  unreviewed: 0,
  'no-home-bucket': 1,
  'no-category': 2,
};

/** Read-only: everything a run would change, and everything it would not. */
export async function planMainCategoryBackfill(
  db: MainCategoryBackfillDb,
): Promise<MainCategoryBackfillPlan> {
  const tree = await db.partCategory.findMany({
    select: { id: true, parentId: true },
  });
  const parentOf = categoryParentMap(tree);
  const bucketOf = (categoryId: string) =>
    mainCategoryForCategory(categoryId, parentOf);

  const [
    parts,
    products,
    listedNullGroups,
    gridGroups,
    keptParts,
    keptProducts,
  ] = await Promise.all([
    db.catalogPart.findMany({
      where: { mainCategory: null },
      select: { id: true, title: true, categoryId: true },
      orderBy: { id: 'asc' },
    }),
    db.product.findMany({
      where: { mainCategory: null },
      select: { id: true, title: true, categoryId: true },
      orderBy: { id: 'asc' },
    }),
    // The same gate the grid applies (categories.service.ts), so "now" and
    // "after" are the numbers a buyer will actually see on each tile.
    db.catalogPart.groupBy({
      by: ['categoryId'],
      where: buyerListed({ mainCategory: null }),
      _count: { _all: true },
    }),
    db.catalogPart.groupBy({
      by: ['mainCategory'],
      where: buyerListed(),
      _count: { _all: true },
    }),
    db.catalogPart.groupBy({
      by: ['categoryId', 'mainCategory'],
      where: { mainCategory: { not: null } },
      _count: { _all: true },
    }),
    db.product.groupBy({
      by: ['categoryId', 'mainCategory'],
      where: { mainCategory: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const fills = new Map<PartMainCategory, BucketFill>();
  const fillFor = (mainCategory: PartMainCategory) => {
    let fill = fills.get(mainCategory);
    if (!fill) {
      fill = { mainCategory, catalogParts: [], products: [] };
      fills.set(mainCategory, fill);
    }
    return fill;
  };
  const unbucketed = new Map<string | null, UnbucketedCategory>();
  const unbucketedFor = (categoryId: string | null) => {
    let entry = unbucketed.get(categoryId);
    if (!entry) {
      entry = {
        categoryId,
        reason:
          categoryId === null
            ? 'no-category'
            : CATEGORIES_WITHOUT_MAIN_CATEGORY.has(categoryId)
              ? 'no-home-bucket'
              : 'unreviewed',
        catalogParts: 0,
        listedCatalogParts: 0,
        products: 0,
      };
      unbucketed.set(categoryId, entry);
    }
    return entry;
  };

  for (const part of parts) {
    const bucket = bucketOf(part.categoryId);
    if (bucket) fillFor(bucket).catalogParts.push(part);
    else unbucketedFor(part.categoryId).catalogParts += 1;
  }
  for (const product of products) {
    const { categoryId } = product;
    const bucket = categoryId === null ? null : bucketOf(categoryId);
    if (bucket && categoryId !== null) {
      fillFor(bucket).products.push({ ...product, categoryId });
    } else {
      unbucketedFor(categoryId).products += 1;
    }
  }

  // Buyer-listed NULL parts per category → the tile each will join, or the
  // unbucketed entry it stays in.
  const gain = new Map<PartMainCategory, number>();
  for (const group of listedNullGroups) {
    const bucket = bucketOf(group.categoryId);
    if (bucket) gain.set(bucket, (gain.get(bucket) ?? 0) + group._count._all);
    else
      unbucketedFor(group.categoryId).listedCatalogParts += group._count._all;
  }
  const now = new Map(
    gridGroups.map((g) => [g.mainCategory, g._count._all] as const),
  );

  const kept: KeptBucket[] = [];
  const collectKept = (
    table: KeptBucket['table'],
    groups: {
      categoryId: string | null;
      mainCategory: PartMainCategory | null;
      _count: { _all: number };
    }[],
  ) => {
    for (const group of groups) {
      if (group.categoryId === null || group.mainCategory === null) continue;
      const fromTree = bucketOf(group.categoryId);
      if (fromTree && fromTree !== group.mainCategory) {
        kept.push({
          table,
          categoryId: group.categoryId,
          stored: group.mainCategory,
          fromTree,
          rows: group._count._all,
        });
      }
    }
  };
  collectKept('catalog_parts', keptParts);
  collectKept('products', keptProducts);

  const total = (u: UnbucketedCategory) => u.catalogParts + u.products;
  return {
    fills: BUCKETS.flatMap((b) => fills.get(b) ?? []),
    unbucketed: [...unbucketed.values()].sort(
      (a, b) =>
        REASON_ORDER[a.reason] - REASON_ORDER[b.reason] ||
        total(b) - total(a) ||
        (a.categoryId ?? '').localeCompare(b.categoryId ?? ''),
    ),
    kept: kept.sort(
      (a, b) =>
        a.table.localeCompare(b.table) ||
        a.categoryId.localeCompare(b.categoryId),
    ),
    homeGrid: BUCKETS.map((mainCategory) => {
      const current = now.get(mainCategory) ?? 0;
      return {
        mainCategory,
        now: current,
        after: current + (gain.get(mainCategory) ?? 0),
      };
    }),
  };
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Write a plan: exactly its rows, each only while it is still NULL and still
 * filed on a category of that bucket — so a bucket written, or a move made,
 * since the plan was read is never overwritten.
 */
export async function applyMainCategoryBackfill(
  db: MainCategoryBackfillDb,
  plan: MainCategoryBackfillPlan,
): Promise<BucketFillResult[]> {
  const results: BucketFillResult[] = [];
  for (const fill of plan.fills) {
    const data = { mainCategory: fill.mainCategory };

    let catalogParts = 0;
    const partCategoryIds = [
      ...new Set(fill.catalogParts.map((r) => r.categoryId)),
    ];
    for (const ids of chunked(
      fill.catalogParts.map((r) => r.id),
      WRITE_CHUNK,
    )) {
      const { count } = await db.catalogPart.updateMany({
        where: {
          id: { in: ids },
          mainCategory: null,
          categoryId: { in: partCategoryIds },
        },
        data,
      });
      catalogParts += count;
    }

    let products = 0;
    const productCategoryIds = [
      ...new Set(fill.products.map((r) => r.categoryId)),
    ];
    for (const ids of chunked(
      fill.products.map((r) => r.id),
      WRITE_CHUNK,
    )) {
      const { count } = await db.product.updateMany({
        where: {
          id: { in: ids },
          mainCategory: null,
          categoryId: { in: productCategoryIds },
        },
        data,
      });
      products += count;
    }

    results.push({ mainCategory: fill.mainCategory, catalogParts, products });
  }
  return results;
}

const num = (n: number, width: number) => String(n).padStart(width);
const tile = (b: PartMainCategory) => `${b} (${MAIN_CATEGORY_TO_SLUG[b]})`;

/** The dry-run report: proposed rows, per-category and per-bucket counts. */
export function describeBackfillPlan(plan: MainCategoryBackfillPlan): string[] {
  const out: string[] = [];

  out.push(
    'ROWS TO FILL (main_category IS NULL → the bucket its category resolves to)',
  );
  if (plan.fills.length === 0) {
    out.push('  none — every row with a home bucket already carries one');
  }
  for (const fill of plan.fills) {
    out.push(
      '',
      `${tile(fill.mainCategory)} ← catalog_parts ${fill.catalogParts.length}, products ${fill.products.length}`,
    );
    const perCategory = new Map<string, { parts: number; products: number }>();
    const countFor = (categoryId: string) => {
      const entry = perCategory.get(categoryId) ?? { parts: 0, products: 0 };
      perCategory.set(categoryId, entry);
      return entry;
    };
    for (const row of fill.catalogParts) countFor(row.categoryId).parts += 1;
    for (const row of fill.products) countFor(row.categoryId).products += 1;
    for (const [categoryId, n] of [...perCategory].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      out.push(
        `  ${categoryId.padEnd(30)}catalog_parts ${num(n.parts, 5)}   products ${num(n.products, 5)}`,
      );
    }
    for (const row of fill.catalogParts) {
      out.push(
        `    catalog_parts  ${row.id}  [${row.categoryId}]  ${row.title}`,
      );
    }
    for (const row of fill.products) {
      out.push(
        `    products       #${row.id}  [${row.categoryId}]  ${row.title}`,
      );
    }
  }

  out.push('', 'ROWS TO FILL PER HOME BUCKET');
  out.push(
    `  ${'bucket'.padEnd(18)}${'catalog_parts'.padStart(14)}${'products'.padStart(10)}`,
  );
  let parts = 0;
  let products = 0;
  for (const bucket of BUCKETS) {
    const fill = plan.fills.find((f) => f.mainCategory === bucket);
    const p = fill?.catalogParts.length ?? 0;
    const q = fill?.products.length ?? 0;
    parts += p;
    products += q;
    out.push(`  ${bucket.padEnd(18)}${num(p, 14)}${num(q, 10)}`);
  }
  out.push(`  ${'TOTAL'.padEnd(18)}${num(parts, 14)}${num(products, 10)}`);

  out.push(
    '',
    'HOME GRID COUNT PER TILE (buyer-listed parts, no vehicle filter)',
    `  ${'tile'.padEnd(36)}${'now'.padStart(6)}${'after'.padStart(8)}`,
  );
  for (const t of plan.homeGrid) {
    const delta = t.after - t.now;
    out.push(
      `  ${tile(t.mainCategory).padEnd(36)}${num(t.now, 6)}${num(t.after, 8)}${delta ? `   (+${delta})` : ''}`,
    );
  }

  out.push('', 'STILL WITHOUT A HOME BUCKET (left NULL, not changed)');
  if (plan.unbucketed.length === 0) out.push('  none');
  for (const u of plan.unbucketed) {
    out.push(
      `  ${(u.categoryId ?? '(no category)').padEnd(30)}${u.reason.padEnd(16)}catalog_parts ${num(u.catalogParts, 5)} (listed ${num(u.listedCatalogParts, 4)})   products ${num(u.products, 5)}`,
    );
  }

  out.push('', 'KEPT: STORED BUCKET DIFFERS FROM THE TREE (never overwritten)');
  if (plan.kept.length === 0) out.push('  none');
  for (const k of plan.kept) {
    out.push(
      `  ${k.table.padEnd(14)}${k.categoryId.padEnd(30)}${k.stored} (tree: ${k.fromTree})   rows ${num(k.rows, 5)}`,
    );
  }
  return out;
}
