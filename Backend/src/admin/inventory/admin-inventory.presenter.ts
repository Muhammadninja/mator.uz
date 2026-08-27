import { Prisma } from '@prisma/client';

/** Derived stock status of a part, from stockQty vs. its lowStockThreshold. */
export type InventoryStockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

/**
 * Prisma `select` for an inventory row. Brand and category are pulled by their
 * display fields in the same read; `id` doubles as the part's SKU (there is no
 * separate sku column on CatalogPart).
 *
 * The category is read with ALL THREE localized names (they are NOT NULL on
 * `part_categories`), so the console can label the row in whatever language the
 * operator has selected without a second request per row. `name` comes along
 * for wire compatibility only — see {@link presentInventoryRow}.
 */
export const ADMIN_INVENTORY_ROW_SELECT = {
  id: true,
  title: true,
  oemNumbers: true,
  gmNumbers: true,
  stockQty: true,
  lowStockThreshold: true,
  purchasePriceUzs: true,
  priceUzs: true,
  cashbackPct: true,
  brand: { select: { id: true, name: true } },
  category: {
    select: { id: true, name: true, nameRu: true, nameUz: true, nameEn: true },
  },
} satisfies Prisma.CatalogPartSelect;

export type AdminInventoryRow = Prisma.CatalogPartGetPayload<{
  select: typeof ADMIN_INVENTORY_ROW_SELECT;
}>;

/** Derive the stock status: out = 0, low = 0 < qty < threshold, in = qty ≥ threshold. */
export function deriveStockStatus(
  stockQty: number,
  lowStockThreshold: number,
): InventoryStockStatus {
  if (stockQty <= 0) return 'out_of_stock';
  if (stockQty < lowStockThreshold) return 'low_stock';
  return 'in_stock';
}

/**
 * Inventory wire row: `sku` is the part id, `oem` is the first OEM number (the
 * primary), Decimals are narrowed to numbers, and stockStatus is derived.
 *
 * `category.nameRu` / `nameUz` / `nameEn` are what the console DISPLAYS, picked
 * by its current interface language. `category.name` is the INTERNAL canonical
 * label (logs, ordering, slug derivation) and is kept on the wire only so
 * existing clients do not break — it must never be rendered to a user, since it
 * is not localized and is English for every seeded bucket.
 */
export function presentInventoryRow(row: AdminInventoryRow) {
  return {
    id: row.id,
    sku: row.id,
    oem: row.oemNumbers[0] ?? null,
    name: row.title,
    brand: row.brand ? { id: row.brand.id, name: row.brand.name } : null,
    category: {
      id: row.category.id,
      // Internal label — deprecated for display, kept for compatibility.
      name: row.category.name,
      nameRu: row.category.nameRu,
      nameUz: row.category.nameUz,
      nameEn: row.category.nameEn,
    },
    stock: row.stockQty,
    lowStockThreshold: row.lowStockThreshold,
    purchasePrice: row.purchasePriceUzs === null ? null : Number(row.purchasePriceUzs),
    retailPrice: Number(row.priceUzs),
    cashbackPct: Number(row.cashbackPct),
    stockStatus: deriveStockStatus(row.stockQty, row.lowStockThreshold),
  };
}
