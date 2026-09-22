-- Driver's Village 1C catalog import.
--
-- Purely ADDITIVE. Nothing is dropped, renamed, retyped or backfilled, and
-- every existing row keeps its exact meaning:
--
--   • sellers.seller_type — TELEGRAM (default, so every existing row and every
--     bot onboarding) or BUSINESS (an integration-fed organization with no
--     Telegram account, e.g. Driver's Village).
--   • sellers.tg_id / sellers.phone become NULLABLE — but only for BUSINESS
--     sellers: the CHECK constraint below keeps both NOT NULL for TELEGRAM
--     sellers, so the Telegram contract is exactly what it was. tg_id stays
--     UNIQUE (the existing index); NULLs are distinct in a unique index, so any
--     number of business sellers coexist. No Telegram id is ever fabricated.
--   • sellers.catalog_seller_id — explicit link from a supply-side seller to the
--     curated buyer-facing dealer it feeds (e.g. 'drivers-village'). NULL for
--     every existing seller, which keeps projecting into seller_<id> as before.
--     Plain id, no FK — the two bounded contexts share no foreign keys.
--   • stocks.source_system / source_code — identity of a position in an external
--     inventory system (Driver's Village: code_1c). NULL for every existing
--     (Telegram) listing. UNIQUE (seller_id, source_system, source_code) is the
--     import's idempotency key; Telegram listings (NULLs) never collide.
--   • stocks.unit — 'PCS' / 'L' for imported rows; NULL for Telegram listings.
--     stocks.quantity is deliberately left an INTEGER: the source file carries
--     whole quantities only, and the importer rejects a fractional one.
--   • products.gm_numbers / oem_numbers — multi-valued labeled part numbers from
--     an import. Default '{}' — "none" for every existing product.
--   • part_makes / catalog_part_make_fits — the "fits every model of this make"
--     fitment state (supply side / buyer read model). New, empty tables.
--
-- Lock profile: every ADD COLUMN has a constant default or none, and DROP NOT
-- NULL is catalog-only. Adding the CHECK constraint scans the (small) sellers
-- table once under a brief lock.
--
-- This migration writes no business data. The Driver's Village business seller
-- is created by an operator (docs/DRIVERS_VILLAGE_IMPORT.md §1), never here.
--
-- DEPLOY ORDER: apply BEFORE deploying the code that reads these columns.

-- CreateEnum
CREATE TYPE "SellerType" AS ENUM ('TELEGRAM', 'BUSINESS');

-- CreateEnum
CREATE TYPE "StockSourceSystem" AS ENUM ('DRIVERS_VILLAGE_1C');

-- AlterTable: generic supply-side seller + curated dealer link
ALTER TABLE "sellers"
  ADD COLUMN "seller_type"       "SellerType" NOT NULL DEFAULT 'TELEGRAM',
  ADD COLUMN "catalog_seller_id" VARCHAR(64),
  ALTER COLUMN "tg_id" DROP NOT NULL,
  ALTER COLUMN "phone" DROP NOT NULL;

-- A Telegram seller keeps its Telegram identity and phone, exactly as before.
-- Not expressible in the Prisma schema; enforced here, at the database.
ALTER TABLE "sellers"
  ADD CONSTRAINT "sellers_telegram_identity_check"
  CHECK ("seller_type" <> 'TELEGRAM' OR ("tg_id" IS NOT NULL AND "phone" IS NOT NULL));

-- AlterTable: labeled, multi-valued part numbers of imported products
ALTER TABLE "products"
  ADD COLUMN "gm_numbers"  TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "oem_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable: external source identity + unit
ALTER TABLE "stocks"
  ADD COLUMN "source_code"   VARCHAR(64),
  ADD COLUMN "source_system" "StockSourceSystem",
  ADD COLUMN "unit"          VARCHAR(16);

-- CreateTable: make-wide fitment (supply side)
CREATE TABLE "part_makes" (
    "part_id"  INTEGER NOT NULL,
    "brand_id" INTEGER NOT NULL,

    CONSTRAINT "part_makes_pkey" PRIMARY KEY ("part_id","brand_id")
);

-- CreateTable: make-wide fitment (buyer read model)
CREATE TABLE "catalog_part_make_fits" (
    "part_id"   VARCHAR(64)  NOT NULL,
    "make_slug" VARCHAR(80)  NOT NULL,
    "make_name" VARCHAR(120) NOT NULL,

    CONSTRAINT "catalog_part_make_fits_pkey" PRIMARY KEY ("part_id","make_slug")
);

-- CreateIndex
CREATE INDEX "part_makes_brand_id_idx" ON "part_makes"("brand_id");

-- CreateIndex
CREATE INDEX "catalog_part_make_fits_make_slug_idx" ON "catalog_part_make_fits"("make_slug");

-- CreateIndex: one catalog dealer is fed by at most one supply-side seller
CREATE UNIQUE INDEX "sellers_catalog_seller_id_key" ON "sellers"("catalog_seller_id");

-- CreateIndex: import idempotency key (seller + source system + code_1c)
CREATE UNIQUE INDEX "stocks_seller_id_source_system_source_code_key" ON "stocks"("seller_id", "source_system", "source_code");

-- AddForeignKey
ALTER TABLE "part_makes" ADD CONSTRAINT "part_makes_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_makes" ADD CONSTRAINT "part_makes_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_part_make_fits" ADD CONSTRAINT "catalog_part_make_fits_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "catalog_parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
