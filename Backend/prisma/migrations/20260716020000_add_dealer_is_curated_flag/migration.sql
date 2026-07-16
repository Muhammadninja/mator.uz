-- Phase 4C (fix): explicit `is_curated` marker on CatalogSeller. GET /v1/dealers
-- must return exactly the curated MATOR-certified dealers, identified by this
-- flag — NOT by whether the presentation fields (initial/color/orders/years)
-- happen to be populated. A projected seller_<id> row that later acquires an
-- `initial` must never leak into the dealer list. Additive and backward-
-- compatible: NOT NULL with a DEFAULT false, so every existing row (including
-- projected sellers) is backfilled to false; only the seed marks d1–d4 true.

-- AlterTable
ALTER TABLE "catalog_sellers" ADD COLUMN     "is_curated" BOOLEAN NOT NULL DEFAULT false;
