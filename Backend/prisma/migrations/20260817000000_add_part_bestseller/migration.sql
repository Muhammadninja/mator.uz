-- Bestseller signals for the macro-category rollup. Nullable-free with defaults
-- so existing rows stay valid; a population job/admin toggle fills them later.
ALTER TABLE "catalog_parts" ADD COLUMN "is_bestseller" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "catalog_parts" ADD COLUMN "sales_count" INTEGER NOT NULL DEFAULT 0;

-- Hot path: filter by main_category, order bestsellers first.
CREATE INDEX "catalog_parts_main_category_is_bestseller_sales_count_idx"
  ON "catalog_parts" ("main_category", "is_bestseller", "sales_count");
