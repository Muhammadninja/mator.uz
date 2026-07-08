/**
 * ONE-TIME BACKFILL: supply-side → buyer-side catalog.
 *
 * Projects the data the Telegram bot writes (Product / Stock / ProductImage /
 * PartModel) into the buyer-facing tables the API reads (CatalogSeller /
 * PartBrand / PartCategory / CatalogPart / PartCompatibility).
 *
 * The two worlds share NO foreign keys, so this script builds the bridge:
 *   Product  ─┐
 *   Stock  ───┼─► CatalogPart   (one CatalogPart per Stock row = per seller listing)
 *   Image  ───┘
 *   Seller  ──► CatalogSeller   (parent, required by CatalogPart.sellerId)
 *   PartModel ► PartBrand       (parent, optional CatalogPart.brandId)
 *              PartCategory     (parent, required CatalogPart.categoryId)
 *
 * Properties (per task requirements):
 *   • Idempotent  — every write is an upsert on a DETERMINISTIC id derived from
 *                   the source row, so re-runs converge and never duplicate.
 *   • Transactional — each product's projection (its parents + all its listings)
 *                   is written in a single prisma.$transaction.
 *   • Prisma-only — no raw SQL.
 *   • Read-only on the supply side — Product/Stock/Image/PartModel are untouched.
 *
 * This script does NOT modify the Telegram pipeline or any API endpoint. It is a
 * one-shot migration of existing data; ongoing propagation is a separate task.
 *
 * Run:  npx ts-node --compiler-options '{"module":"commonjs"}' prisma/backfill-catalog.ts
 */
import { PrismaClient, Prisma, PartCondition } from '@prisma/client';

const prisma = new PrismaClient();

// ── Deterministic id helpers ────────────────────────────────────────────────
// Buyer-side ids are VarChar(64). We derive them from the immutable supply-side
// integer primary keys so the same source row always maps to the same buyer id
// (that is what makes the whole script idempotent). No IDs are hardcoded.
const catalogSellerId = (sellerId: number) => `seller_${sellerId}`;
const partBrandId = (brandId: number) => `brand_${brandId}`;
// Single synthetic category — see MAPPING NOTES (categoryId is NOT NULL and the
// supply side has no category concept).
const UNCATEGORIZED_ID = 'cat_uncategorized';
const catalogPartId = (stockId: number) => `part_stock_${stockId}`;
const compatId = (stockId: number, modelId: number) => `pc_${stockId}_${modelId}`;

interface Stats {
  productsScanned: number;
  stocksScanned: number;
  catalogSellers: number;
  partBrands: number;
  partCategories: number;
  catalogParts: number;
  partCompatibilities: number;
  skippedNoStock: number;
}

async function main() {
  const stats: Stats = {
    productsScanned: 0,
    stocksScanned: 0,
    catalogSellers: 0,
    partBrands: 0,
    partCategories: 0,
    catalogParts: 0,
    partCompatibilities: 0,
    skippedNoStock: 0,
  };

  console.log('[backfill] starting supply → buyer catalog backfill');

  // The single fallback category. categoryId on CatalogPart is required and the
  // supply side (products) has no category data, so every part lands here until
  // a real categorization pipeline exists. Idempotent upsert.
  await prisma.partCategory.upsert({
    where: { id: UNCATEGORIZED_ID },
    update: {},
    create: { id: UNCATEGORIZED_ID, name: 'Uncategorized' },
  });
  stats.partCategories += 1;

  // Track parents we've already ensured this run to avoid redundant upserts
  // (the DB upsert would be safe anyway; this just trims work + keeps stats honest).
  const ensuredSellers = new Set<string>();
  const ensuredBrands = new Set<string>();

  const products = await prisma.product.findMany({
    include: {
      stocks: { include: { seller: true } },
      images: { orderBy: { sortOrder: 'asc' } },
      partModels: { include: { model: { include: { brand: true } } } },
    },
    orderBy: { id: 'asc' },
  });

  for (const product of products) {
    stats.productsScanned += 1;

    if (product.stocks.length === 0) {
      // No Stock row = no price and no seller. priceUzs and sellerId are both
      // required (NOT NULL) on CatalogPart, so such a product cannot become a
      // buyer listing without inventing data — we skip it instead. (In the
      // current DB this never triggers: all products have a stock row.)
      stats.skippedNoStock += 1;
      console.warn(`[backfill] product #${product.id} has no stock — skipped (no price/seller source)`);
      continue;
    }

    // Distinct brands to create for this product, from its vehicle links.
    // PartBrand is the buyer-side brand (part manufacturer slot). The supply
    // side has no part-brand concept, so we reuse the *vehicle* brand attached
    // via PartModel → CarModel → Brand. See MAPPING NOTES.
    const brandsForProduct = new Map<number, string>(); // supply Brand.id → name
    for (const pm of product.partModels) {
      const b = pm.model.brand;
      brandsForProduct.set(b.id, b.name);
    }

    // Build all writes for THIS product into one transaction.
    const ops: Prisma.PrismaPromise<unknown>[] = [];

    // Parent brands (optional FK — only if the product has vehicle links).
    for (const [bId, bName] of brandsForProduct) {
      const id = partBrandId(bId);
      if (!ensuredBrands.has(id)) {
        ops.push(
          prisma.partBrand.upsert({
            where: { id },
            update: { name: bName },
            create: { id, name: bName },
          }),
        );
      }
    }

    // One CatalogPart per Stock row (a product sold by N sellers → N listings).
    for (const stock of product.stocks) {
      stats.stocksScanned += 1;

      // Parent seller (required FK).
      const sellerId = catalogSellerId(stock.sellerId);
      const sellerName =
        stock.seller.storeName ?? stock.seller.marketName ?? `Seller ${stock.sellerId}`;
      if (!ensuredSellers.has(sellerId)) {
        ops.push(
          prisma.catalogSeller.upsert({
            where: { id: sellerId },
            update: { name: sellerName, internalSellerId: stock.sellerId },
            create: { id: sellerId, name: sellerName, internalSellerId: stock.sellerId },
          }),
        );
      }

      // Pick a brandId for the listing: if the product links to exactly one
      // vehicle brand, use it; otherwise leave null (brandId is optional and a
      // multi-brand listing has no single part brand). Deterministic: smallest
      // supply Brand.id wins for stability across runs.
      const brandId =
        brandsForProduct.size === 1
          ? partBrandId([...brandsForProduct.keys()][0])
          : null;

      const partId = catalogPartId(stock.id);
      const images = product.images.map((img) => img.url);

      const partData = {
        title: product.title,
        brandId,
        categoryId: UNCATEGORIZED_ID,
        sellerId,
        oemNumbers: product.gmNumber ? [product.gmNumber] : [],
        priceUzs: stock.priceUzs,
        // currency: schema default "UZS"
        condition: PartCondition.NEW, // supply side has no condition — safest default is NEW (schema default)
        inStock: stock.quantity > 0,
        stockQty: stock.quantity,
        // deliveryEtaDaysMin/Max: no source → left null (both optional)
        images,
      };

      ops.push(
        prisma.catalogPart.upsert({
          where: { id: partId },
          update: partData,
          create: { id: partId, ...partData },
        }),
      );
      stats.catalogParts += 1;

      // Vehicle compatibility rows. PartModel links a product to a CarModel; the
      // buyer PartCompatibility links to VehicleTrim/VehicleEngine — a different
      // vehicle taxonomy with NO shared ids. We cannot map model→trim safely, so
      // we do NOT fabricate compatibility rows. (Documented in MAPPING NOTES.)
      // Left intentionally empty; compatId helper reserved for a future, real
      // mapping so the id scheme is already deterministic.
      void compatId;
    }

    await prisma.$transaction(ops);

    // Count parents as ensured only after the tx commits.
    for (const [bId] of brandsForProduct) {
      const id = partBrandId(bId);
      if (!ensuredBrands.has(id)) {
        ensuredBrands.add(id);
        stats.partBrands += 1;
      }
    }
    for (const stock of product.stocks) {
      const id = catalogSellerId(stock.sellerId);
      if (!ensuredSellers.has(id)) {
        ensuredSellers.add(id);
        stats.catalogSellers += 1;
      }
    }

    console.log(
      `[backfill] product #${product.id} "${product.title}" → ${product.stocks.length} listing(s)`,
    );
  }

  console.log('\n[backfill] DONE. Statistics (rows created-or-updated this run):');
  console.table({
    'Products scanned': stats.productsScanned,
    'Stocks scanned': stats.stocksScanned,
    'Products skipped (no stock)': stats.skippedNoStock,
    'CatalogSeller (parents)': stats.catalogSellers,
    'PartBrand (parents)': stats.partBrands,
    'PartCategory (parents)': stats.partCategories,
    'CatalogPart (listings)': stats.catalogParts,
    'PartCompatibility': stats.partCompatibilities,
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
