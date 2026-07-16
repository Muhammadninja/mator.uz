-- Phase 4C: "MATOR Certified" dealer storefront presentation fields on
-- CatalogSeller. Additive, backward-compatible: all four columns are nullable,
-- so existing rows (incl. projected seller_<id> rows) are unaffected.

-- AlterTable
ALTER TABLE "catalog_sellers" ADD COLUMN     "color" VARCHAR(9),
ADD COLUMN     "initial" VARCHAR(4),
ADD COLUMN     "orders" VARCHAR(20),
ADD COLUMN     "years" INTEGER;
