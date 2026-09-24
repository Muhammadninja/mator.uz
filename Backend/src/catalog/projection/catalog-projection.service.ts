import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  PartCondition,
  PartMainCategory,
  PartNumberType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MAIN_CATEGORY_TO_SLUG,
  ROOT_TO_MAIN_CATEGORY,
} from '../categories/category-map';
import { localizedNamesFor } from '../../prisma/seed-data/category-names.seed';

/** Prefix of the synthetic Product.gmNumber key used when a listing has no real
 *  part number — such values must never be projected as searchable numbers. */
const SYNTHETIC_KEY_PREFIX = 'tg_';

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

  // ── Category-root resolution ──────────────────────────────────────────────
  // `buildProjectionOps` is a PURE builder (no I/O) so the live path and the
  // backfill share one mapping, which means the tree walk cannot happen inside
  // it. Instead the async callers resolve `categoryId → rootId` up front and
  // hand the result in.
  //
  // The whole PartCategory tree is ~60 rows and changes only when an admin
  // edits it, so it is cached in-process behind the same 300s TTL the reference
  // API uses for its Redis copy. Worst case after an admin adds a category: one
  // listing projected in the next 5 minutes derives no bucket, which the next
  // projection corrects.
  private static readonly ROOT_CACHE_TTL_MS = 300_000;
  private rootByCategoryId: ReadonlyMap<string, string> | null = null;
  private rootCacheLoadedAt = 0;

  /**
   * `categoryId → the id of its ROOT ancestor` for every category in the tree.
   * A root maps to itself. Cycles (which the schema permits but the admin UI
   * does not create) terminate at the tree depth rather than spinning.
   */
  private async categoryRoots(): Promise<ReadonlyMap<string, string>> {
    const now = Date.now();
    if (
      this.rootByCategoryId &&
      now - this.rootCacheLoadedAt < CatalogProjectionService.ROOT_CACHE_TTL_MS
    ) {
      return this.rootByCategoryId;
    }

    const rows = await this.prisma.partCategory.findMany({
      select: { id: true, parentId: true },
    });
    const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
    const roots = new Map<string, string>();

    for (const { id } of rows) {
      let cursor = id;
      // Bounded by the row count, so a malformed cycle cannot hang the walk.
      for (let hops = 0; hops <= rows.length; hops += 1) {
        const parent = parentOf.get(cursor);
        if (!parent || parent === cursor) break;
        cursor = parent;
      }
      roots.set(id, cursor);
    }

    this.rootByCategoryId = roots;
    this.rootCacheLoadedAt = now;
    return roots;
  }

  /**
   * The bucket a part belongs to: the classifier's answer when it produced one,
   * otherwise the bucket owned by its category's ROOT (see
   * ROOT_TO_MAIN_CATEGORY). Null when neither applies, exactly as before.
   *
   * A bot-assigned `mainCategory` ALWAYS wins — this only fills a gap, so it can
   * never overwrite a real classification.
   */
  static deriveMainCategory(
    productMainCategory: PartMainCategory | null,
    categoryId: string,
    rootByCategoryId: ReadonlyMap<string, string>,
  ): PartMainCategory | null {
    if (productMainCategory) return productMainCategory;
    const root = rootByCategoryId.get(categoryId);
    return root ? (ROOT_TO_MAIN_CATEGORY[root] ?? null) : null;
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
  async projectStock(stockId: number): Promise<string | null> {
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

    const ops = this.buildProjectionOps(stock, await this.categoryRoots());
    await this.prisma.$transaction(ops);
    return CatalogProjectionService.catalogPartId(stock.id);
  }

  /** Alias for projectStock — an update is the same idempotent upsert. */
  updateProjection(stockId: number): Promise<string | null> {
    return this.projectStock(stockId);
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
  async projectProduct(productId: number): Promise<string[]> {
    const stocks = await this.prisma.stock.findMany({
      where: { productId },
      select: { id: true },
    });

    const ids: string[] = [];
    for (const { id } of stocks) {
      const partId = await this.projectStock(id);
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
    /** `categoryId → root id`, resolved by the async caller (see
     *  `categoryRoots`). Omitted in tests that don't exercise bucket
     *  derivation — an empty map simply leaves `mainCategory` as the
     *  classifier set it, i.e. the pre-existing behaviour. */
    rootByCategoryId: ReadonlyMap<string, string> = new Map(),
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

    // Distinct vehicle brands linked to this product. The buyer PartBrand slot
    // (part manufacturer) has no supply-side source, so we reuse the *vehicle*
    // brand attached via PartModel → CarModel → Brand.
    const brandsForProduct = new Map<number, string>(); // supply Brand.id → name
    for (const pm of product.partModels) {
      brandsForProduct.set(pm.model.brand.id, pm.model.brand.name);
    }
    // Make-wide links name a vehicle brand just as specific-model links do.
    for (const pmk of product.partMakes ?? []) {
      brandsForProduct.set(pmk.brand.id, pmk.brand.name);
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

    // Pick a brandId for the listing: exactly one linked vehicle brand → use it;
    // otherwise null (a multi-brand or brandless listing has no single part
    // brand). Deterministic: smallest supply Brand.id wins for stability.
    const brandId =
      brandsForProduct.size === 1
        ? CatalogProjectionService.partBrandId([...brandsForProduct.keys()][0])
        : null;

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

    // Point the part at its PartCategory, in priority order:
    //
    //   1. the supply-side `categoryId` the seller actually CHOSE (the dynamic
    //      tree). This is the authoritative answer and the only one that works
    //      for a category with no enum equivalent — an admin-created "Другое"
    //      child (Motorcycle Oil, …) has mainCategory = null, so deriving from
    //      the enum alone would bury every such listing in the fallback bucket
    //      and make it unreachable by ?category=<id>;
    //   2. else the canonical category mirroring its bot-assigned main category
    //      (BRAKES → 'brakes', …) — the pre-existing path, unchanged, which still
    //      covers every legacy row and every classifier-only listing;
    //   3. else the fallback bucket.
    const categoryId =
      product.categoryId ??
      (product.mainCategory
        ? (MAIN_CATEGORY_TO_SLUG[product.mainCategory] ??
          CatalogProjectionService.UNCATEGORIZED_ID)
        : CatalogProjectionService.UNCATEGORIZED_ID);

    const partData = {
      title: product.title,
      brandId,
      categoryId,
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
      // Classified attributes projected verbatim from the supply-side Product
      // (set by the Telegram classifier) — enables indexed buyer-side filtering.
      // Bucket for the home grid. Projected verbatim when the classifier
      // assigned one; otherwise derived from the category's ROOT, so a listing
      // filed on a real subcategory (e.g. 'synthetic-motor-oil') still rolls up
      // to its bucket instead of vanishing from the tile. See
      // ROOT_TO_MAIN_CATEGORY.
      mainCategory: CatalogProjectionService.deriveMainCategory(
        product.mainCategory,
        categoryId,
        rootByCategoryId,
      ),
      vehicleCategory: product.vehicleCategory,
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
