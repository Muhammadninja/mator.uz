/**
 * BACKFILL: give every unbucketed part the home-grid bucket (`mainCategory`) its
 * category resolves to in the tree.
 *
 * WHY. The home grid both COUNTS and LISTS by `mainCategory`
 * (categories.service.ts / parts.service.ts), while listings are filed on a
 * PartCategory anywhere in the tree. A part filed on a real subcategory that
 * nothing ever bucketed carries `mainCategory = null` and is invisible to every
 * tile — reachable only by drilling the exact subcategory id. The Driver's
 * Village classification import buckets only positions filed on a bucket row
 * itself, which left every tile but "Масла и жидкости" empty.
 *
 * CatalogProjectionService derives the bucket for every NEW projection by the
 * same rule this script applies to rows already in the database:
 * mainCategoryForCategory — the node's own entry in CATEGORY_ID_TO_MAIN_CATEGORY,
 * else its nearest ancestor's; nodes in CATEGORIES_WITHOUT_MAIN_CATEGORY stay
 * unbucketed. Both sides are filled so they agree:
 *   - Product     (supply source, read first by the projection)
 *   - CatalogPart (buyer read model, what the grid counts and lists)
 *
 * SAFE BY DEFAULT: the dry-run lists every row it would fill, per-category and
 * per-bucket counts, each tile's count before/after, what stays unbucketed and
 * why, and the stored buckets it leaves alone — and writes nothing. Pass
 * --apply to persist. Only ever fills a NULL, so a real classification is never
 * overwritten and re-running after apply is a no-op.
 *
 * Run:  npm run backfill:root-buckets            # dry-run
 *       npm run backfill:root-buckets -- --apply
 */
import { PrismaClient } from '@prisma/client';
import {
  applyMainCategoryBackfill,
  describeBackfillPlan,
  planMainCategoryBackfill,
} from '../src/catalog/categories/main-category-backfill';

const APPLY = process.argv.includes('--apply');

async function main(prisma: PrismaClient) {
  console.log(
    APPLY
      ? 'APPLYING category → bucket backfill…\n'
      : 'DRY-RUN (no writes; pass --apply to persist)\n',
  );

  const plan = await planMainCategoryBackfill(prisma);
  for (const line of describeBackfillPlan(plan)) console.log(line);

  const planned = plan.fills.reduce(
    (n, f) => n + f.catalogParts.length + f.products.length,
    0,
  );
  if (!APPLY) {
    if (planned > 0) {
      console.log('\nRe-run with -- --apply to persist these changes.');
    }
    return;
  }

  const written = await applyMainCategoryBackfill(prisma, plan);
  console.log('\nWROTE');
  for (const w of written) {
    console.log(
      `  ${w.mainCategory.padEnd(18)}catalog_parts ${w.catalogParts}   products ${w.products}`,
    );
  }
  // A second plan proves the run converged: anything left appeared or was moved
  // after the plan was read, and a re-run picks it up.
  const after = await planMainCategoryBackfill(prisma);
  const left = after.fills.reduce(
    (n, f) => n + f.catalogParts.length + f.products.length,
    0,
  );
  console.log(`\nRe-check: ${left} row(s) still to fill (expected 0).`);
}

const prisma = new PrismaClient();
main(prisma)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
