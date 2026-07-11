import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PartCondition } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * CatalogProjectionService — the SINGLE, authoritative mapping from the
 * supply-side seller domain (Product / Stock / ProductImage / PartModel /
 * Seller) into the buyer-facing read model (CatalogSeller / PartBrand /
 * PartCategory / CatalogPart).
 *
 * The two bounded contexts share NO foreign keys. This service is the only
 * bridge between them, so the mapping is defined exactly once and reused by:
 *   • the Telegram upload pipeline (live, after each commit),
 *   • the one-shot backfill script (prisma/backfill-catalog.ts),
 *   • any future admin tool or seller app.
 *
 * The unit of projection is a Stock row: one Stock (a seller's listing of a
 * product) maps to exactly one CatalogPart. Every write is an idempotent upsert
 * on a DETERMINISTIC id derived from the immutable supply-side integer PK, so
 * projecting the same Stock repeatedly converges and never duplicates.
 *
 * Read-only on the supply side — Product/Stock/Image/PartModel/Seller are never
 * written here.
 */
@Injectable()
export class CatalogProjectionService {
  private readonly logger = new Logger(CatalogProjectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Deterministic id helpers ──────────────────────────────────────────────
  // Buyer-side ids are VarChar(64), derived from supply-side integer PKs so the
  // same source row always maps to the same buyer id (this is what makes the
  // projection idempotent). No ids are hardcoded.
  static catalogSellerId = (sellerId: number) => `seller_${sellerId}`;
  static partBrandId = (brandId: number) => `brand_${brandId}`;
  static catalogPartId = (stockId: number) => `part_stock_${stockId}`;

  // Single synthetic fallback category. CatalogPart.categoryId is NOT NULL and
  // the supply side has no category concept, so every part lands here until a
  // real categorization pipeline exists.
  static readonly UNCATEGORIZED_ID = 'cat_uncategorized';

  /** The relation shape every projection needs from a Stock row. */
  private static readonly stockInclude = {
    seller: true,
    product: {
      include: {
        images: { orderBy: { sortOrder: 'asc' as const } },
        partModels: { include: { model: { include: { brand: true } } } },
      },
    },
  } satisfies Prisma.StockInclude;

  /**
   * Project a single Stock row into the buyer catalog: ensure the fallback
   * category, the parent CatalogSeller, any parent PartBrand, then upsert the
   * CatalogPart. Create-or-update — safe to call for both new and changed
   * listings (updateProjection is an alias). All writes run in one transaction.
   *
   * No-op with a warning when the Stock no longer exists (e.g. deleted between
   * enqueue and projection); use deleteProjection to remove a CatalogPart.
   *
   * @returns the CatalogPart id written, or null if the stock was gone.
   */
  async projectStock(stockId: number): Promise<string | null> {
    const stock = await this.prisma.stock.findUnique({
      where: { id: stockId },
      include: CatalogProjectionService.stockInclude,
    });

    if (!stock) {
      this.logger.warn(`projectStock(${stockId}): stock not found — skipped`);
      return null;
    }

    const ops = this.buildProjectionOps(stock);
    await this.prisma.$transaction(ops);
    return CatalogProjectionService.catalogPartId(stock.id);
  }

  /** Alias for projectStock — an update is the same idempotent upsert. */
  updateProjection(stockId: number): Promise<string | null> {
    return this.projectStock(stockId);
  }

  /**
   * Remove the CatalogPart projected from a Stock row (the seller listing
   * disappeared). Idempotent: deleting an absent projection is a no-op. Parent
   * CatalogSeller / PartBrand / PartCategory rows are left in place — they are
   * shared across listings and cheap to keep.
   */
  async deleteProjection(stockId: number): Promise<void> {
    const id = CatalogProjectionService.catalogPartId(stockId);
    await this.prisma.catalogPart.deleteMany({ where: { id } });
  }

  /**
   * Build the ordered upsert operations that project ONE fully-loaded Stock row
   * into the buyer catalog. Kept as a pure builder (no I/O) so both the live
   * per-stock path and the backfill batch path share the exact same mapping.
   * The ops are ordered parents-before-children to satisfy FKs within the
   * transaction.
   */
  buildProjectionOps(
    stock: Prisma.StockGetPayload<{ include: typeof CatalogProjectionService.stockInclude }>,
  ): Prisma.PrismaPromise<unknown>[] {
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    const product = stock.product;

    // Fallback category (required FK). Idempotent upsert every time — the DB
    // handles the "already exists" case; cost is negligible next to the write.
    ops.push(
      this.prisma.partCategory.upsert({
        where: { id: CatalogProjectionService.UNCATEGORIZED_ID },
        update: {},
        create: { id: CatalogProjectionService.UNCATEGORIZED_ID, name: 'Uncategorized' },
      }),
    );

    // Distinct vehicle brands linked to this product. The buyer PartBrand slot
    // (part manufacturer) has no supply-side source, so we reuse the *vehicle*
    // brand attached via PartModel → CarModel → Brand.
    const brandsForProduct = new Map<number, string>(); // supply Brand.id → name
    for (const pm of product.partModels) {
      brandsForProduct.set(pm.model.brand.id, pm.model.brand.name);
    }

    // Parent brands (optional FK — only if the product has vehicle links).
    for (const [bId, bName] of brandsForProduct) {
      const id = CatalogProjectionService.partBrandId(bId);
      ops.push(
        this.prisma.partBrand.upsert({
          where: { id },
          update: { name: bName },
          create: { id, name: bName },
        }),
      );
    }

    // Parent seller (required FK).
    const sellerId = CatalogProjectionService.catalogSellerId(stock.sellerId);
    const sellerName =
      stock.seller.storeName ?? stock.seller.marketName ?? `Seller ${stock.sellerId}`;
    ops.push(
      this.prisma.catalogSeller.upsert({
        where: { id: sellerId },
        update: { name: sellerName, internalSellerId: stock.sellerId },
        create: { id: sellerId, name: sellerName, internalSellerId: stock.sellerId },
      }),
    );

    // Pick a brandId for the listing: exactly one linked vehicle brand → use it;
    // otherwise null (a multi-brand or brandless listing has no single part
    // brand). Deterministic: smallest supply Brand.id wins for stability.
    const brandId =
      brandsForProduct.size === 1
        ? CatalogProjectionService.partBrandId([...brandsForProduct.keys()][0])
        : null;

    const partId = CatalogProjectionService.catalogPartId(stock.id);
    const images = product.images.map((img) => img.url);

    const partData = {
      title: product.title,
      brandId,
      categoryId: CatalogProjectionService.UNCATEGORIZED_ID,
      sellerId,
      oemNumbers: product.gmNumber ? [product.gmNumber] : [],
      priceUzs: stock.priceUzs,
      // currency: schema default "UZS"
      condition: PartCondition.NEW, // supply side has no condition — schema default
      inStock: stock.quantity > 0,
      stockQty: stock.quantity,
      // deliveryEtaDaysMin/Max: no source → left null (both optional)
      images,
      // Classified attributes projected verbatim from the supply-side Product
      // (set by the Telegram classifier) — enables indexed buyer-side filtering.
      mainCategory: product.mainCategory,
      vehicleCategory: product.vehicleCategory,
      partBrandName: product.partBrand,
      originRegion: product.originRegion,
      isOem: product.isOem,
      isGm: product.isGm,
      isUniversal: product.isUniversal,
    };

    ops.push(
      this.prisma.catalogPart.upsert({
        where: { id: partId },
        update: partData,
        create: { id: partId, ...partData },
      }),
    );

    // Make/model fitment: denormalize the supply-side PartModel links into
    // catalog_part_fits so the buyer catalog can filter by make/model with an
    // index. Replace-then-insert keeps the projection idempotent (a re-projection
    // of a changed listing reconciles removed/added models). Universal parts have
    // no PartModel rows, so they contribute no fits (matched via isUniversal).
    ops.push(this.prisma.catalogPartFit.deleteMany({ where: { partId } }));
    const fitRows = this.buildFitRows(partId, product.partModels);
    if (fitRows.length > 0) {
      ops.push(this.prisma.catalogPartFit.createMany({ data: fitRows, skipDuplicates: true }));
    }

    // Trim/engine-level PartCompatibility is still intentionally NOT projected:
    // the supply side links to CarModel while the buyer side links to
    // VehicleTrim/VehicleEngine — a different taxonomy with NO shared ids. We do
    // not fabricate compatibility rows. (Documented in the original backfill.)

    return ops;
  }

  /** Deterministic slug from a name, matching the frontend id convention
   *  (e.g. "Chevrolet" → "chevrolet", "Land Cruiser 200" → "land-cruiser-200"). */
  private static slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Build the deduplicated make/model fit rows for a product from its PartModel
   * links. Each row carries canonical make/model names plus slugs matching the
   * frontend contract's make_<slug> / model_<make>_<model> id convention. Rows
   * are keyed by (partId, modelSlug); duplicates (same model under a product) are
   * collapsed.
   */
  private buildFitRows(
    partId: string,
    partModels: Array<{ model: { name: string; brand: { name: string } } }>,
  ): { partId: string; makeSlug: string; modelSlug: string; makeName: string; modelName: string }[] {
    const byModelSlug = new Map<
      string,
      { partId: string; makeSlug: string; modelSlug: string; makeName: string; modelName: string }
    >();
    for (const pm of partModels) {
      const makeName = pm.model.brand.name;
      const modelName = pm.model.name;
      const makeSlug = `make_${CatalogProjectionService.slugify(makeName)}`;
      const modelSlug = `model_${CatalogProjectionService.slugify(makeName)}_${CatalogProjectionService.slugify(modelName)}`;
      if (!byModelSlug.has(modelSlug)) {
        byModelSlug.set(modelSlug, { partId, makeSlug, modelSlug, makeName, modelName });
      }
    }
    return [...byModelSlug.values()];
  }
}
