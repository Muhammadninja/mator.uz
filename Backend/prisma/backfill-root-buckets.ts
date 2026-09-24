/**
 * BACKFILL: give every unclassified part under a mapped ROOT its buyer-grid
 * bucket (`mainCategory`).
 *
 * WHY. The home grid both COUNTS and LISTS by `mainCategory`
 * (categories.service.ts / parts.service.ts), while sellers file listings on a
 * PartCategory anywhere in the tree. A part filed on a real subcategory that the
 * keyword classifier never bucketed therefore carries `mainCategory = null` and
 * is invisible to its own tile — reachable only by drilling the exact
 * subcategory id.
 *
 * That is what hid the motor oils: they sit on 'synthetic-motor-oil' /
 * 'semi-synthetic-motor-oil' (children of the 'motor-oil' root) with no
 * mainCategory, so "Масла и жидкости" listed only the 4 legacy rows that
 * happened to carry the enum.
 *
 * CatalogProjectionService now derives the bucket from the category's root for
 * every NEW projection (see ROOT_TO_MAIN_CATEGORY). This script applies the same
 * rule to rows already in the database, on both sides so the two agree and the
 * change survives a future projection:
 *   - Product     (supply source, read first by the projection)
 *   - CatalogPart (buyer read model, what the grid counts and lists)
 *
 * SAFE BY DEFAULT: dry-run — prints every planned change and writes nothing.
 * Pass --apply to persist. Only ever fills a NULL: a row that already carries a
 * mainCategory is left untouched, so a real classification is never overwritten
 * and re-running after apply is a no-op.
 *
 * Run:  npm run backfill:root-buckets            # dry-run
 *       npm run backfill:root-buckets -- --apply
 */
import { PrismaClient } from '@prisma/client';
import { ROOT_TO_MAIN_CATEGORY } from '../src/catalog/categories/category-map';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Every category id whose ROOT ancestor is `rootId`, including the root. */
async function descendantsOf(rootId: string): Promise<string[]> {
  const rows = await prisma.partCategory.findMany({
    select: { id: true, parentId: true },
  });
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    childrenOf.set(r.parentId, [...(childrenOf.get(r.parentId) ?? []), r.id]);
  }
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift() as string;
    if (out.includes(id)) continue; // cycle guard
    out.push(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return out;
}

async function main() {
  console.log(
    APPLY
      ? 'APPLYING root → bucket backfill…\n'
      : 'DRY-RUN (no writes; pass --apply to persist)\n',
  );

  let totalParts = 0;
  let totalProducts = 0;

  for (const [rootId, mainCategory] of Object.entries(ROOT_TO_MAIN_CATEGORY)) {
    const ids = await descendantsOf(rootId);
    if (ids.length === 0) {
      console.warn(`[skip] root '${rootId}' is not in the tree`);
      continue;
    }

    // Only NULLs — a classifier-assigned bucket always wins.
    const where = { categoryId: { in: ids }, mainCategory: null } as const;
    const parts = await prisma.catalogPart.findMany({
      where,
      select: { id: true, title: true, categoryId: true },
      orderBy: { id: 'asc' },
    });
    const products = await prisma.product.count({ where });

    console.log(
      `root '${rootId}' → ${mainCategory}\n` +
        `  tree: ${ids.join(', ')}\n` +
        `  CatalogPart rows to fill: ${parts.length}\n` +
        `  Product rows to fill:     ${products}`,
    );
    for (const p of parts) {
      console.log(`    ${p.id}  [${p.categoryId}]  ${p.title}`);
    }

    if (APPLY) {
      const a = await prisma.catalogPart.updateMany({
        where,
        data: { mainCategory },
      });
      const b = await prisma.product.updateMany({
        where,
        data: { mainCategory },
      });
      console.log(`  WROTE CatalogPart=${a.count} Product=${b.count}`);
      totalParts += a.count;
      totalProducts += b.count;
    } else {
      totalParts += parts.length;
      totalProducts += products;
    }
    console.log('');
  }

  console.table({
    Mode: APPLY ? 'APPLIED' : 'DRY-RUN',
    'CatalogPart rows': totalParts,
    'Product rows': totalProducts,
  });
  if (!APPLY && totalParts + totalProducts > 0) {
    console.log('\nRe-run with -- --apply to persist these changes.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
