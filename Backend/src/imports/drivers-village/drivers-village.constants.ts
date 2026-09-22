import { StockSourceSystem } from '@prisma/client';

/**
 * The existing buyer-facing dealer every imported position belongs to.
 *
 * This is a CatalogSeller id (the curated dealer row that already exists in
 * production), never created or renamed by the importer. The supply-side
 * Seller that owns the Stock rows is the one explicitly linked to it through
 * `Seller.catalogSellerId`; see DriversVillageStore.findLinkedSeller.
 */
export const DRIVERS_VILLAGE_CATALOG_SELLER_ID = 'drivers-village';

/** Source system stamped on every imported Stock row (with code_1c). */
export const DRIVERS_VILLAGE_SOURCE_SYSTEM: StockSourceSystem =
  StockSourceSystem.DRIVERS_VILLAGE_1C;

/** Input and write-path bounds. Checked before any row is processed. */
export const IMPORT_LIMITS = {
  /** Largest accepted input file. The current export is ~130 KB. */
  maxFileBytes: 20 * 1024 * 1024,
  /** Largest accepted number of data rows (excluding the header). */
  maxRows: 50_000,
  /** Positions written per database transaction. */
  batchSize: 100,
  /** Upper bound on one batch transaction (Neon round-trips are ~20–50 ms). */
  batchTimeoutMs: 180_000,
  /** How long a batch may wait for a pooled connection. */
  batchMaxWaitMs: 20_000,
} as const;

/** Stock.priceUzs is DECIMAL(14,2): at most 12 integer digits. */
export const MAX_PRICE_UZS = '999999999999.99';

/**
 * Upper bound on a quantity. Stock.quantity and CatalogPart.stockQty are 32-bit
 * integers; the bound keeps well inside that range.
 */
export const MAX_QUANTITY = '1000000000';

/** Column bounds mirrored from the schema. */
export const FIELD_LIMITS = {
  code1c: 64,
  title: 255,
  categoryId: 64,
  partNumber: 50,
} as const;
