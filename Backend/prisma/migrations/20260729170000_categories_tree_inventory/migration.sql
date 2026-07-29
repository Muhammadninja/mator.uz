-- Category-tree manager + Smart-Inventory admin module.
--
-- Extends the EXISTING buyer catalog: part_categories (the relational category
-- entity linked from catalog_parts.category_id) gains tree-ordering + slug +
-- audit columns, and catalog_parts gains the inventory columns the
-- Smart-Inventory batch console reads and writes. All additive with safe
-- defaults, so every existing row and query keeps working.

-- ── part_categories: slug + tree ordering + audit timestamps ────────────────
ALTER TABLE "part_categories"
  ADD COLUMN "slug" VARCHAR(96),
  ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Ids are already slug-shaped (e.g. "engine-oil"); backfill the slug from the id
-- so existing rows have a meaningful, unique slug immediately.
UPDATE "part_categories" SET "slug" = "id" WHERE "slug" IS NULL;

CREATE UNIQUE INDEX "part_categories_slug_key" ON "part_categories"("slug");
CREATE INDEX "part_categories_parent_id_sort_order_idx" ON "part_categories"("parent_id", "sort_order");

-- ── catalog_parts: inventory columns ────────────────────────────────────────
ALTER TABLE "catalog_parts"
  ADD COLUMN "purchase_price_uzs" DECIMAL(14,2),
  ADD COLUMN "cashback_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN "stock_qty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "low_stock_threshold" INTEGER NOT NULL DEFAULT 5;

-- Seed on-hand quantity from the legacy boolean: in-stock rows get one unit so
-- they read as "in_stock" (>= default threshold is false at qty 1, so they read
-- as "low_stock" until a real count is entered) rather than "out_of_stock".
UPDATE "catalog_parts" SET "stock_qty" = 1 WHERE "in_stock" = true;

CREATE INDEX "catalog_parts_stock_qty_idx" ON "catalog_parts"("stock_qty");
