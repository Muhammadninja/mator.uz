-- Supply-side category id: let a Product/ProductDraft point at the exact
-- PartCategory it belongs to (its id == slug, e.g. "motorcycle-oil"), so an
-- admin-created "Другое" child (which has no PartMainCategory enum mirror) can
-- carry its listings into the buyer catalog. Authoritative over the enum in the
-- catalog projection; nullable + SET NULL so a removed category never blocks a
-- listing (the projection falls back to the enum, then the Uncategorized bucket).

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "category_id" VARCHAR(64);

-- AlterTable
ALTER TABLE "product_drafts" ADD COLUMN     "category_id" VARCHAR(64);

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "product_drafts_category_id_idx" ON "product_drafts"("category_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "part_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_drafts" ADD CONSTRAINT "product_drafts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "part_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill existing listings from their classified enum, using the enum mirror
-- the 12 canonical PartCategory rows already carry (main_category). Idempotent:
-- only fills rows that don't yet have a category_id. Rows with no/unmapped enum
-- stay NULL and the projection resolves them exactly as before.
UPDATE "products" p
SET "category_id" = pc."id"
FROM "part_categories" pc
WHERE pc."main_category" = p."main_category"
  AND p."category_id" IS NULL;
