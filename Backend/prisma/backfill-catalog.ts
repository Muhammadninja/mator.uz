/**
 * ONE-TIME / RE-RUNNABLE BACKFILL: supply-side → buyer-side catalog.
 *
 * Projects the data the Telegram bot writes (Product / Stock / ProductImage /
 * PartModel) into the buyer-facing tables the API reads (CatalogSeller /
 * PartBrand / PartCategory / CatalogPart).
 *
 * This script no longer contains any mapping logic of its own. The ONE
 * authoritative Product/Stock → CatalogPart mapping lives in
 * CatalogProjectionService (src/catalog/projection/catalog-projection.service.ts)
 * and is shared by the Telegram live pipeline, this backfill, and any future
 * admin/seller tooling. Here we simply iterate existing Stock rows and hand each
 * to that service, so a backfill run produces catalog data IDENTICAL to what the
 * live projection writes.
 *
 * Properties (inherited from CatalogProjectionService):
 *   • Idempotent    — every write is an upsert on a deterministic id derived
 *                     from the source row, so re-runs converge and never dup.
 *   • Transactional — each Stock's projection (its parents + its listing) is
 *                     written in a single prisma.$transaction.
 *   • Prisma-only   — no raw SQL.
 *   • Read-only on the supply side — Product/Stock/Image/PartModel untouched.
 *
 * This script does NOT modify the Telegram pipeline or any API endpoint.
 *
 * Run:  npm run backfill:catalog
 *   (= ts-node --compiler-options '{"module":"commonjs"}' prisma/backfill-catalog.ts)
 */
import { PrismaClient } from '@prisma/client';
import { CatalogProjectionService } from '../src/catalog/projection/catalog-projection.service';
import { PrismaService } from '../src/prisma/prisma.service';

const prisma = new PrismaClient();

async function main() {
  console.log('[backfill] starting supply → buyer catalog backfill');

  // Reuse the single authoritative mapping. CatalogProjectionService only needs
  // a PrismaClient to build/run its projection ops; PrismaService extends
  // PrismaClient, so the standalone script client satisfies it.
  const projection = new CatalogProjectionService(prisma as unknown as PrismaService);

  // Iterate every seller listing (Stock = one CatalogPart) in a stable order.
  const stocks = await prisma.stock.findMany({
    select: { id: true, productId: true },
    orderBy: { id: 'asc' },
  });

  let projected = 0;
  let skipped = 0;

  for (const stock of stocks) {
    const partId = await projection.projectStock(stock.id);
    if (partId) {
      projected += 1;
      console.log(`[backfill] stock #${stock.id} (product #${stock.productId}) → ${partId}`);
    } else {
      // projectStock returns null only if the stock vanished mid-run — with a
      // stable snapshot this never triggers, but count it honestly if it does.
      skipped += 1;
      console.warn(`[backfill] stock #${stock.id} vanished — skipped`);
    }
  }

  console.log('\n[backfill] DONE. Statistics (this run):');
  console.table({
    'Stocks scanned': stocks.length,
    'CatalogPart (listings) projected': projected,
    'Stocks skipped (vanished)': skipped,
  });

  // Report live totals so a re-run visibly converges (idempotency proof).
  const [sellers, brands, cats, parts] = await Promise.all([
    prisma.catalogSeller.count(),
    prisma.partBrand.count(),
    prisma.partCategory.count(),
    prisma.catalogPart.count(),
  ]);
  console.log('[backfill] live table totals now:', {
    catalog_sellers: sellers,
    part_brands: brands,
    part_categories: cats,
    catalog_parts: parts,
  });
}

main()
  .catch((e) => {
    console.error('[backfill] FAILED:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
