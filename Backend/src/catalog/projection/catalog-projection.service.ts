import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  PartCondition,
  PartMainCategory,
  PartNumberType,
  PartVehicleCategory,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MAIN_CATEGORY_TO_SLUG,
  categoryParentMap,
  mainCategoryForCategory,
} from '../categories/category-map';
import { localizedNamesFor } from '../../prisma/seed-data/category-names.seed';

/** Prefix of the synthetic Product.gmNumber key used when a listing has no real
 *  part number — such values must never be projected as searchable numbers. */
const SYNTHETIC_KEY_PREFIX = 'tg_';

/** How a re-projection treats what the catalog part already holds. */
export interface ProjectionOptions {
  /**
   * Leave an EXISTING part's classification (category_id, main_category,
   * vehicle_category) as it is — for a re-projection caused by an edit that is
   * not a classification (a rating), so it cannot undo an operator's move. A
   * part created by the projection is still classified from its product.
   */
  keepClassification?: boolean;
}

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

  /**
   * The CatalogSeller a supply-side seller's listings project into. A seller an
   * operator explicitly linked to an existing curated dealer
   * (`Seller.catalogSellerId`, e.g. 'drivers-village') projects into THAT
   * dealer; every other seller keeps its synthetic `seller_<id>` storefront.
   * Never inferred from names — the link is an explicit column or nothing.
   */
  static catalogSellerIdFor = (seller: {
    id: number;
    catalogSellerId?: string | null;
  }): string =>
    seller.catalogSellerId ??
    CatalogProjectionService.catalogSellerId(seller.id);
  static partBrandId = (brandId: number) => `brand_${brandId}`;
  static catalogPartId = (stockId: number) => `part_stock_${stockId}`;

  /**
   * Build the (gmNumbers, oemNumbers) search arrays for the buyer catalog from a
   * Product's stored numbers and labeled type, WITHOUT cross-copying:
   *   • GM      → the number is searchable only as a GM number
   *   • OEM     → the number is searchable only as an OEM number
   *   • UNKNOWN → the (unlabeled) number is searchable as BOTH — we cannot claim
   *               a type, so both searches must find it
   * Synthetic idempotency keys (tg_…) and blanks are excluded. Exported as a pure
   * static so the backfill script and tests reuse the exact same rule.
   */
  static numberSearchArrays(
    gmNumber: string | null,
    oemNumber: string | null,
    type: PartNumberType,
  ): { gmNumbers: string[]; oemNumbers: string[] } {
    const real = (n: string | null): string | null =>
      n && n.trim() && !n.startsWith(SYNTHETIC_KEY_PREFIX) ? n.trim() : null;
    const gm = real(gmNumber);
    const oem = real(oemNumber);

    if (type === PartNumberType.OEM) {
      return { gmNumbers: [], oemNumbers: oem ? [oem] : [] };
    }
    if (type === PartNumberType.GM) {
      return { gmNumbers: gm ? [gm] : [], oemNumbers: [] };
    }
    // UNKNOWN: the raw value lives in gmNumber; expose it to both searches.
    const both = gm ?? oem;
    return { gmNumbers: both ? [both] : [], oemNumbers: both ? [both] : [] };
  }

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
        partMakes: { include: { brand: true } },
      },
    },
  } satisfies Prisma.StockInclude;

  // ── Category-tree resolution ──────────────────────────────────────────────
  // `buildProjectionOps` is a PURE builder (no I/O) so the live path and the
  // backfill share one mapping, which means the tree read cannot happen inside
  // it. Instead the async callers load `categoryId → parentId` up front and
  // hand it in; mainCategoryForCategory walks it.
  //
  // The whole PartCategory tree is under a hundred rows and changes only when
  // an admin edits it, so it is cached in-process behind the same 300s TTL the
  // reference API uses for its Redis copy. Worst case after an admin adds a
  // category: one listing projected in the next 5 minutes derives no bucket,
  // which the next projection corrects.
  private static readonly TREE_CACHE_TTL_MS = 300_000;
  private parentByCategoryId: ReadonlyMap<string, string | null> | null = null;
  private treeCacheLoadedAt = 0;

  /** `categoryId → parentId` for every category in the tree (a root → null). */
  private async categoryParents(): Promise<ReadonlyMap<string, string | null>> {
    const now = Date.now();
    if (
      this.parentByCategoryId &&
      now - this.treeCacheLoadedAt < CatalogProjectionService.TREE_CACHE_TTL_MS
    ) {
      return this.parentByCategoryId;
    }

    const rows = await this.prisma.partCategory.findMany({
      select: { id: true, parentId: true },
    });
    this.parentByCategoryId = categoryParentMap(rows);
    this.treeCacheLoadedAt = now;
    return this.parentByCategoryId;
  }

  /**
   * The bucket a part belongs to: the one already assigned when there is one,
   * otherwise the one its category resolves to in the tree — the node's own
   * rule first, then its nearest ancestor's (see mainCategoryForCategory).
   * Null when neither applies.
   *
   * An assigned `mainCategory` ALWAYS wins — this only fills a gap, so it can
   * never overwrite a real classification.
   */
  static deriveMainCategory(
    productMainCategory: PartMainCategory | null,
    categoryId: string,
    parentByCategoryId: ReadonlyMap<string, string | null>,
  ): PartMainCategory | null {
    if (productMainCategory) return productMainCategory;
    return mainCategoryForCategory(categoryId, parentByCategoryId);
  }

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
  async projectStock(
    stockId: number,
    opts: ProjectionOptions = {},
  ): Promise<string | null> {
    const stock = await this.prisma.stock.findUnique({
      where: { id: stockId },
      include: CatalogProjectionService.stockInclude,
    });

    if (!stock) {
      this.logger.warn(`projectStock(${stockId}): stock not found — skipped`);
      return null;
    }

    // A seller linked to a curated dealer projects into that dealer's EXISTING
    // row, which this service never creates (it is admin-managed presentation).
    // Fail loudly with the actual cause rather than letting the part upsert die
    // on an opaque foreign-key error.
    if (stock.seller.catalogSellerId) {
      const dealer = await this.prisma.catalogSeller.findUnique({
        where: { id: stock.seller.catalogSellerId },
        select: { id: true },
      });
      if (!dealer) {
        throw new Error(
          `projectStock(${stockId}): seller #${stock.sellerId} is linked to ` +
            `catalog seller "${stock.seller.catalogSellerId}", which does not exist`,
        );
      }
    }

    const ops = this.buildProjectionOps(
      stock,
      await this.categoryParents(),
      opts,
    );
    await this.prisma.$transaction(ops);
    return CatalogProjectionService.catalogPartId(stock.id);
  }

  /** Alias for projectStock — an update is the same idempotent upsert. */
  updateProjection(stockId: number): Promise<string | null> {
    return this.projectStock(stockId);
  }

  /**
   * After a price/stock synchronization of an imported position: copy the
   * stock's price and/or quantity to its EXISTING catalog part — only the
   * columns that changed, nothing else. Its title, numbers, images, category,
   * fits (catalog_part_fits are not deleted or recreated) and the admin-owned
   * columns (purchase price, cashback, a retail price or stock count an
   * operator set) stay as they are. A stock never projected yet gets the full
   * projectStock (its creation).
   */
  async projectStockLevels(
    stockId: number,
    changed: { price: boolean; quantity: boolean },
  ): Promise<string | null> {
    const partId = CatalogProjectionService.catalogPartId(stockId);
    const [stock, part] = await Promise.all([
      this.prisma.stock.findUnique({
        where: { id: stockId },
        select: { priceUzs: true, quantity: true, sourceSystem: true },
      }),
      this.prisma.catalogPart.findUnique({
        where: { id: partId },
        select: { id: true },
      }),
    ]);
    if (!stock) {
      this.logger.warn(
        `projectStockLevels(${stockId}): stock not found — skipped`,
      );
      return null;
    }
    if (!part) return this.projectStock(stockId);

    const data: Prisma.CatalogPartUpdateInput = {};
    if (changed.price) data.priceUzs = stock.priceUzs;
    if (changed.quantity) {
      data.inStock = stock.quantity > 0;
      // As in projectStock: a real count only for an imported position.
      if (stock.sourceSystem) data.stockQty = stock.quantity;
    }
    if (Object.keys(data).length > 0)
      await this.prisma.catalogPart.update({ where: { id: partId }, data });
    return partId;
  }

  /**
   * After the classification import changed a product: project its
   * classification and fitment onto its EXISTING catalog part, and nothing
   * else (price, stock, title, images and the admin-owned columns stay).
   *   • Fits are ADDED from part_models / part_makes (insert, skip
   *     duplicates) — never deleted, so no link is lost; is_universal and the
   *     vehicle-derived part brand follow the product.
   *   • The category (category_id + main/vehicle mirrors, derived from the
   *     product exactly as projectStock does) is written only when asked, and
   *     only while the part still sits in `category.expected` — a
   *     compare-and-set, so an operator's move made meanwhile always wins.
   * A stock never projected yet gets the full projectStock, which creates the
   * part with the product's classification.
   */
  async projectClassification(
    stockId: number,
    opts: { category?: { expected: string } } = {},
  ): Promise<{ partId: string | null; categoryWritten: boolean }> {
    const stock = await this.prisma.stock.findUnique({
      where: { id: stockId },
      include: CatalogProjectionService.stockInclude,
    });
    if (!stock) {
      this.logger.warn(
        `projectClassification(${stockId}): stock not found — skipped`,
      );
      return { partId: null, categoryWritten: false };
    }
    const partId = CatalogProjectionService.catalogPartId(stock.id);
    const part = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      select: { id: true },
    });
    if (!part) {
      await this.projectStock(stockId);
      return { partId, categoryWritten: opts.category !== undefined };
    }

    const product = stock.product;
    const brands = this.vehicleBrands(product);
    const ops: Prisma.PrismaPromise<unknown>[] = [
      ...this.partBrandOps(brands),
      this.prisma.catalogPart.update({
        where: { id: partId },
        data: {
          isUniversal: product.isUniversal,
          brandId: CatalogProjectionService.singleBrandId(brands),
        },
      }),
    ];
    const categoryOp = opts.category ? ops.length : -1;
    if (opts.category)
      ops.push(
        this.prisma.catalogPart.updateMany({
          where: { id: partId, categoryId: opts.category.expected },
          data: CatalogProjectionService.classificationOf(
            product,
            await this.categoryParents(),
          ),
        }),
      );
    const fitRows = this.buildFitRows(partId, product.partModels);
    if (fitRows.length > 0)
      ops.push(
        this.prisma.catalogPartFit.createMany({
          data: fitRows,
          skipDuplicates: true,
        }),
      );
    const makeFitRows = this.buildMakeFitRows(partId, product.partMakes ?? []);
    if (makeFitRows.length > 0)
      ops.push(
        this.prisma.catalogPartMakeFit.createMany({
          data: makeFitRows,
          skipDuplicates: true,
        }),
      );
    const results = await this.prisma.$transaction(ops);
    return {
      partId,
      categoryWritten:
        categoryOp >= 0 &&
        (results[categoryOp] as { count: number }).count === 1,
    };
  }

  /**
   * The part's classification derived from its supply-side product, in
   * priority order:
   *   1. the supply-side `categoryId` the seller actually CHOSE (the dynamic
   *      tree). This is the authoritative answer and the only one that works
   *      for a category with no enum equivalent — an admin-created "Другое"
   *      child (Motorcycle Oil, …) has mainCategory = null, so deriving from
   *      the enum alone would bury every such listing in the fallback bucket
   *      and make it unreachable by ?category=<id>;
   *   2. else the canonical category mirroring its bot-assigned main category
   *      (BRAKES → 'brakes', …) — the pre-existing path, unchanged, which still
   *      covers every legacy row and every classifier-only listing;
   *   3. else the fallback bucket.
   * The home-grid bucket (mainCategory) is projected verbatim when one was
   * assigned; otherwise derived from the category tree — the node's own rule,
   * else its nearest ancestor's — so a listing filed on a real subcategory
   * (e.g. 'front-brake-pads') still rolls up to its bucket instead of
   * vanishing from the tile. See CATEGORY_ID_TO_MAIN_CATEGORY.
   */
  static classificationOf(
    product: {
      categoryId: string | null;
      mainCategory: PartMainCategory | null;
      vehicleCategory: PartVehicleCategory | null;
    },
    parentByCategoryId: ReadonlyMap<string, string | null>,
  ) {
    const categoryId =
      product.categoryId ??
      (product.mainCategory
        ? (MAIN_CATEGORY_TO_SLUG[product.mainCategory] ??
          CatalogProjectionService.UNCATEGORIZED_ID)
        : CatalogProjectionService.UNCATEGORIZED_ID);
    return {
      categoryId,
      mainCategory: CatalogProjectionService.deriveMainCategory(
        product.mainCategory,
        categoryId,
        parentByCategoryId,
      ),
      vehicleCategory: product.vehicleCategory,
    };
  }

  /**
   * Distinct vehicle brands linked to a product (supply Brand.id → name). The
   * buyer PartBrand slot (part manufacturer) has no supply-side source, so the
   * *vehicle* brand attached via PartModel → CarModel → Brand is reused;
   * make-wide links name a vehicle brand just as specific-model links do.
   */
  private vehicleBrands(product: {
    partModels: { model: { brand: { id: number; name: string } } }[];
    partMakes?: { brand: { id: number; name: string } }[];
  }): Map<number, string> {
    const brands = new Map<number, string>();
    for (const pm of product.partModels)
      brands.set(pm.model.brand.id, pm.model.brand.name);
    for (const pmk of product.partMakes ?? [])
      brands.set(pmk.brand.id, pmk.brand.name);
    return brands;
  }

  /** Parent PartBrand rows (optional FK — only if the product has links). */
  private partBrandOps(
    brands: Map<number, string>,
  ): Prisma.PrismaPromise<unknown>[] {
    return [...brands].map(([bId, bName]) => {
      const id = CatalogProjectionService.partBrandId(bId);
      return this.prisma.partBrand.upsert({
        where: { id },
        update: { name: bName },
        create: { id, name: bName },
      });
    });
  }

  /**
   * The listing's brandId: exactly one linked vehicle brand → that brand;
   * otherwise null (a multi-brand or brandless listing has no single part
   * brand).
   */
  private static singleBrandId(brands: Map<number, string>): string | null {
    return brands.size === 1
      ? CatalogProjectionService.partBrandId([...brands.keys()][0])
      : null;
  }

  /**
   * Re-project EVERY Stock row of one Product, so a change to a product-level
   * attribute (today: the curated rating) reaches the buyer catalog immediately
   * instead of waiting for a batch job.
   *
   * The unit of projection is a Stock, not a Product — one product listed by N
   * sellers is N CatalogParts — so a product-level edit has to fan out across
   * its stocks. Each is projected through the ordinary idempotent path, so this
   * introduces no second mapping and a product with no stocks is simply a no-op
   * (nothing is listed for buyers to see).
   *
   * @returns the CatalogPart ids written.
   */
  async projectProduct(
    productId: number,
    opts: ProjectionOptions = {},
  ): Promise<string[]> {
    const stocks = await this.prisma.stock.findMany({
      where: { productId },
      select: { id: true },
    });

    const ids: string[] = [];
    for (const { id } of stocks) {
      const partId = await this.projectStock(id, opts);
      if (partId) ids.push(partId);
    }
    return ids;
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
    stock: Prisma.StockGetPayload<{
      include: typeof CatalogProjectionService.stockInclude;
    }>,
    /** `categoryId → parentId`, loaded by the async caller (see
     *  `categoryParents`). Omitted in tests that don't exercise bucket
     *  derivation — with an empty map only a category's OWN rule applies (no
     *  ancestor is known), and an assigned mainCategory still always wins. */
    parentByCategoryId: ReadonlyMap<string, string | null> = new Map(),
    opts: ProjectionOptions = {},
  ): Prisma.PrismaPromise<unknown>[] {
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    const product = stock.product;

    // Fallback category (required FK). Idempotent upsert every time — the DB
    // handles the "already exists" case; cost is negligible next to the write.
    ops.push(
      this.prisma.partCategory.upsert({
        where: { id: CatalogProjectionService.UNCATEGORIZED_ID },
        update: {},
        create: {
          id: CatalogProjectionService.UNCATEGORIZED_ID,
          name: 'Uncategorized',
          // The three localized names are NOT NULL, and this fallback bucket is
          // created by the projection itself — so it carries its own
          // translations rather than depending on a seed having run first.
          ...localizedNamesFor(
            CatalogProjectionService.UNCATEGORIZED_ID,
            'Uncategorized',
          ),
        },
      }),
    );

    // Distinct vehicle brands linked to this product, and their parent
    // PartBrand rows (optional FK — only if the product has vehicle links).
    const brandsForProduct = this.vehicleBrands(product);
    ops.push(...this.partBrandOps(brandsForProduct));

    // Parent seller (required FK). A seller linked to a curated dealer projects
    // into that dealer's existing row, which is admin-owned presentation (name,
    // logo, storefront flags) and therefore NOT upserted here — projectStock
    // verifies it exists. Every other seller keeps its synthetic seller_<id>
    // row, upserted exactly as before.
    const sellerId = CatalogProjectionService.catalogSellerIdFor(stock.seller);
    if (!stock.seller.catalogSellerId) {
      const sellerName =
        stock.seller.storeName ??
        stock.seller.marketName ??
        `Seller ${stock.sellerId}`;
      ops.push(
        this.prisma.catalogSeller.upsert({
          where: { id: sellerId },
          update: { name: sellerName, internalSellerId: stock.sellerId },
          create: {
            id: sellerId,
            name: sellerName,
            internalSellerId: stock.sellerId,
          },
        }),
      );
    }

    const brandId = CatalogProjectionService.singleBrandId(brandsForProduct);

    const partId = CatalogProjectionService.catalogPartId(stock.id);
    const images = product.images.map((img) => img.url);

    // Project the part number into the GM/OEM search arrays by its LABELED type,
    // without cross-copying. A GM-labeled number is searchable only as GM, an
    // OEM-labeled one only as OEM, and an UNKNOWN (unlabeled) number is exposed
    // to BOTH searches (its true type is unknown). Synthetic idempotency keys
    // (tg_…, produced when a listing carried no number) are never real numbers,
    // so they are excluded from both arrays.
    const legacyNumbers = CatalogProjectionService.numberSearchArrays(
      product.gmNumber,
      product.oemNumber,
      product.partNumberType,
    );
    // Plus the multi-valued LABELED numbers an import stores (already in the
    // normalizeOem canonical form). Each list keeps its own label — a GM number
    // is never copied into the OEM array or vice versa — and duplicates are
    // collapsed so a number is listed once.
    const gmNumbers = uniqueStrings([
      ...legacyNumbers.gmNumbers,
      ...(product.gmNumbers ?? []),
    ]);
    const oemNumbers = uniqueStrings([
      ...legacyNumbers.oemNumbers,
      ...(product.oemNumbers ?? []),
    ]);

    // The part's classification (see classificationOf), kept apart from
    // partData because an imported position writes it on create only (see the
    // upsert below).
    const classification = CatalogProjectionService.classificationOf(
      product,
      parentByCategoryId,
    );

    const partData = {
      title: product.title,
      brandId,
      sellerId,
      oemNumbers,
      gmNumbers,
      partNumberType: product.partNumberType,
      priceUzs: stock.priceUzs,
      // currency: schema default "UZS"
      condition: PartCondition.NEW, // supply side has no condition — schema default
      inStock: stock.quantity > 0,
      // The on-hand count, ONLY for a position imported from an external stock
      // system — the one case where Stock.quantity is a real warehouse count.
      // Telegram listings carry the schema default quantity (1), which is not a
      // count, so their stockQty is left to its existing owners exactly as
      // before.
      ...(stock.sourceSystem ? { stockQty: stock.quantity } : {}),
      // deliveryEtaDaysMin/Max: no source → left null (both optional)
      images,
      partBrandName: product.partBrand,
      originRegion: product.originRegion,
      isOem: product.isOem,
      isGm: product.isGm,
      isUniversal: product.isUniversal,
      // Listing kind + its kind-specific attributes, projected verbatim so the
      // buyer side can render an oil card without joining back to the supply
      // domain. Non-oil kinds project nulls, which is what they hold.
      kind: product.kind,
      oilViscosity: product.oilViscosity,
      oilType: product.oilType,
      oilVolumeMl: product.oilVolumeMl,
      antifreezeWeightG: product.antifreezeWeightG,
      // The listing's sale form, projected verbatim like every attribute above.
      // It is what lets the Payme receipt builder pick between this row's
      // category's two package codes without reaching back into the supply
      // domain — the codes themselves stay on the category and are NOT copied.
      packageForm: product.packageForm,
      // Curated rating, projected verbatim like every other Product attribute
      // above. It is admin-maintained data, NOT user reviews — the buyer side
      // only ever reads it. Copying it here (rather than joining CatalogPart
      // back to Product) is what keeps buyer catalog reads free of a cross-
      // context join, and is why an admin edit must re-project the affected
      // stocks to become visible.
      ratingAvg: product.ratingAvg,
      reviewCount: product.reviewCount,
    };

    // An IMPORTED position (Stock.sourceSystem set — Driver's Village 1C) is
    // classified in Mator, never by its price/stock sync: the part is created
    // in whatever bucket the product resolves to (the fallback for a new
    // position) and an operator files it from the admin console, which writes
    // catalog_parts.category_id directly (bulk-move). Every later projection
    // of that stock — a photo update, a rating edit — must keep that choice,
    // so its classification is written on CREATE only here; the explicitly run
    // classification import writes it through projectClassification, guarded
    // by a compare-and-set. A Telegram listing keeps the previous behaviour:
    // its seller re-picks the category in the bot, and the update carries it —
    // unless the caller re-projects for an edit that is not a classification
    // (`keepClassification`), which must not undo an operator's bulk-move.
    ops.push(
      this.prisma.catalogPart.upsert({
        where: { id: partId },
        update:
          stock.sourceSystem || opts.keepClassification
            ? partData
            : { ...partData, ...classification },
        create: { id: partId, ...partData, ...classification },
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
      ops.push(
        this.prisma.catalogPartFit.createMany({
          data: fitRows,
          skipDuplicates: true,
        }),
      );
    }

    // Make-wide fitment ("every model of this make"), reconciled the same way:
    // replace-then-insert, so a re-projection drops a make the listing no
    // longer claims. Products without part_makes rows project none.
    ops.push(this.prisma.catalogPartMakeFit.deleteMany({ where: { partId } }));
    const makeFitRows = this.buildMakeFitRows(partId, product.partMakes ?? []);
    if (makeFitRows.length > 0) {
      ops.push(
        this.prisma.catalogPartMakeFit.createMany({
          data: makeFitRows,
          skipDuplicates: true,
        }),
      );
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
  ): {
    partId: string;
    makeSlug: string;
    modelSlug: string;
    makeName: string;
    modelName: string;
  }[] {
    const byModelSlug = new Map<
      string,
      {
        partId: string;
        makeSlug: string;
        modelSlug: string;
        makeName: string;
        modelName: string;
      }
    >();
    for (const pm of partModels) {
      const makeName = pm.model.brand.name;
      const modelName = pm.model.name;
      const makeSlug = `make_${CatalogProjectionService.slugify(makeName)}`;
      const modelSlug = `model_${CatalogProjectionService.slugify(makeName)}_${CatalogProjectionService.slugify(modelName)}`;
      if (!byModelSlug.has(modelSlug)) {
        byModelSlug.set(modelSlug, {
          partId,
          makeSlug,
          modelSlug,
          makeName,
          modelName,
        });
      }
    }
    return [...byModelSlug.values()];
  }

  /**
   * Deduplicated make-wide fit rows from a product's part_makes links, using the
   * same make slug convention as {@link buildFitRows} (make_<slug>), so a buyer
   * make filter matches both tables with one value.
   */
  private buildMakeFitRows(
    partId: string,
    partMakes: Array<{ brand: { name: string } }>,
  ): { partId: string; makeSlug: string; makeName: string }[] {
    const bySlug = new Map<
      string,
      { partId: string; makeSlug: string; makeName: string }
    >();
    for (const pmk of partMakes) {
      const makeName = pmk.brand.name;
      const makeSlug = `make_${CatalogProjectionService.slugify(makeName)}`;
      if (!bySlug.has(makeSlug)) {
        bySlug.set(makeSlug, { partId, makeSlug, makeName });
      }
    }
    return [...bySlug.values()];
  }
}

/** Order-preserving de-duplication of non-blank strings. */
function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim() !== ''))];
}
