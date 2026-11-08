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
 *
 * The PROJECTION step is read-only on the supply side. The reclassify/reconcile
 * step below DOES write two supply-side tables — Product (classified attributes)
 * and part_models (fitment reconciliation, to purge stale/hallucinated links) —
 * both idempotently and derived only from existing listing text. Stock and
 * ProductImage are never written.
 *
 * This script does NOT modify the Telegram pipeline or any API endpoint.
 *
 * DESTRUCTIVE: it re-derives classification, rebuilds part_models from the listing
 * text (erasing Driver's Village and seller-picked fitment) and re-projects price,
 * stock and category. Guarded by src/maintenance/maintenance-guard.ts:
 *
 * Run:  npm run backfill:catalog                                  (dry run, writes nothing)
 *       npm run backfill:catalog -- --apply --confirm=<code>
 *       … --allow-database=<host/db>                              (any non-local database)
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import {
  type MaintenancePlan,
  runMaintenance,
} from '../src/maintenance/maintenance-guard';
import { CatalogProjectionService } from '../src/catalog/projection/catalog-projection.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { classifyPart } from '../src/ai/part-classifier';
import { deriveVehicleCompatibility } from '../src/ai/vehicle-catalog';
import { persistVehicleLinks } from '../src/telegram/vehicle-links';

const SCRIPT = 'backfill:catalog';

/**
 * Reclassify existing Products that predate the classifier so their stored
 * category/region/OEM/GM fields are populated before projection, AND reconcile
 * their part_models against the current text-derived compatibility. Idempotent —
 * re-running re-derives the same values; safe to run repeatedly.
 *
 * The part_models reconciliation is a ONE-TIME CLEANUP of stale fitment: earlier
 * pipeline versions could persist a vehicle inferred from a GM/OEM number, and
 * before the persistVehicleLinks fix a re-listing never removed a previously
 * written link. Here we re-derive make/model from the listing TEXT ONLY (the
 * same rule the sanitizer enforces — never from the number, never from an LLM)
 * and clear-then-recreate part_models so phantom rows like "Audi 100" on a
 * title/description/GM-only listing are dropped. The verified OEM database is
 * NOT consulted here (cleanup stays conservative; the live parse path is what
 * adds verified-OEM compatibility going forward).
 */
async function reclassifyProducts(prisma: PrismaClient) {
  const products = await prisma.product.findMany({
    select: { id: true, title: true, description: true, partNumberType: true },
    orderBy: { id: 'asc' },
  });
  let updated = 0;
  for (const p of products) {
    // OEM/GM flags come from the stored part-number label (single source of
    // truth); category/region/make still come from the text.
    const c = classifyPart(p.title, p.description, p.partNumberType);
    await prisma.product.update({
      where: { id: p.id },
      data: {
        mainCategory: c.mainCategory,
        vehicleCategory: c.vehicleCategory,
        partBrand: c.make,
        originRegion: c.originRegion,
        isOem: c.isOem,
        isGm: c.isGm,
      },
    });

    // Reconcile part_models from the TEXT-derived compatibility, dropping stale
    // links (isUniversal → cleared; specific → clear+recreate; none → cleared).
    const compat = deriveVehicleCompatibility([p.title, p.description]);
    await persistVehicleLinks(prisma, p.id, {
      isUniversal: compat.isUniversal,
      vehicles: compat.vehicles,
    });

    updated += 1;
  }
  console.log(`[backfill] reclassified + reconciled fitment for ${updated} product(s)`);
}

const CLASSIFIED = [
  'mainCategory',
  'vehicleCategory',
  'partBrand',
  'originRegion',
  'isOem',
  'isGm',
] as const;

/** What a real run would change. Reads only. */
export async function buildBackfillPlan(
  prisma: PrismaClient,
): Promise<MaintenancePlan> {
  const [products, stocks] = await Promise.all([
    prisma.product.findMany({
      select: {
        id: true,
        title: true,
        description: true,
        partNumberType: true,
        mainCategory: true,
        vehicleCategory: true,
        partBrand: true,
        originRegion: true,
        isOem: true,
        isGm: true,
        partModels: {
          select: {
            model: { select: { name: true, brand: { select: { name: true } } } },
          },
        },
      },
      orderBy: { id: 'asc' },
    }),
    prisma.stock.findMany({ select: { id: true }, orderBy: { id: 'asc' } }),
  ]);

  const items: unknown[] = [];
  let classified = 0;
  let fitment = 0;
  for (const p of products) {
    const c = classifyPart(p.title, p.description, p.partNumberType);
    const next = {
      mainCategory: c.mainCategory,
      vehicleCategory: c.vehicleCategory,
      partBrand: c.make,
      originRegion: c.originRegion,
      isOem: c.isOem,
      isGm: c.isGm,
    };
    const changed = CLASSIFIED.filter((key) => p[key] !== next[key]);
    if (changed.length > 0) {
      classified += 1;
      items.push({
        product: p.id,
        classification: Object.fromEntries(
          changed.map((key) => [key, { from: p[key], to: next[key] }]),
        ),
      });
    }
    const compat = deriveVehicleCompatibility([p.title, p.description]);
    const before = p.partModels
      .map((m) => `${m.model.brand.name}|${m.model.name}`)
      .sort();
    const after = compat.isUniversal
      ? []
      : compat.vehicles
          .filter((v) => v.brand)
          .map((v) => `${v.brand}|${v.model}`)
          .sort();
    if (before.join() !== after.join()) {
      fitment += 1;
      items.push({ product: p.id, fitment: { from: before, to: after } });
    }
  }
  if (stocks.length > 0) {
    items.push({ reproject: stocks.map((stock) => stock.id) });
  }
  return {
    summary: [
      `${products.length} product(s) read`,
      `${classified} product(s) would be reclassified`,
      `${fitment} product(s) would have their fitment replaced from listing text`,
      `${stocks.length} stock(s) would be re-projected, resetting category, price and stock on their catalog parts`,
    ],
    items,
  };
}

async function applyBackfill(prisma: PrismaClient) {
  console.log('[backfill] starting supply → buyer catalog backfill');

  // Populate the classified attributes on existing products first, so the
  // projection below copies real category/region/OEM/GM values (not nulls).
  await reclassifyProducts(prisma);

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

/** The entry point, separate from the CLI wrapper so that it can be exercised. */
export function runBackfill(
  prisma: PrismaClient,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  return runMaintenance({
    script: SCRIPT,
    argv,
    env,
    buildPlan: () => buildBackfillPlan(prisma),
    apply: () => applyBackfill(prisma),
  });
}

if (require.main === module) {
  const prisma = new PrismaClient();
  runBackfill(prisma, process.argv.slice(2), process.env)
    .catch((e) => {
      console.error('[backfill] FAILED:', e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
