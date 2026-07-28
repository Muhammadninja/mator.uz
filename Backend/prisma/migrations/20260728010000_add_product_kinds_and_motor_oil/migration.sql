-- Introduce PRODUCT KINDS and the first non-spare-part kind: MOTOR_OIL.
--
-- Purely ADDITIVE: two NEW enums plus nullable/defaulted columns on three
-- existing tables. No column is dropped, renamed, retyped or backfilled, and no
-- existing row is rewritten beyond receiving the `kind` default — so every
-- product, draft and catalog part that exists today keeps its exact current
-- meaning and every current query keeps returning what it returned before.
--
-- `kind` defaults to SPARE_PART, which IS what every pre-existing row is: the
-- only questionnaire that has ever existed is the spare-parts one. That makes
-- the default a statement of fact rather than a guess, so no data migration is
-- needed.
--
-- The oil attribute columns are nullable because they are meaningful only for
-- kind = MOTOR_OIL; for every other kind they stay NULL. A future "Другое"
-- category (antifreeze, brake fluid, batteries, …) follows the same shape: a new
-- ProductKind value plus its own nullable columns, touching nothing that exists.

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('SPARE_PART', 'MOTOR_OIL');

-- CreateEnum
CREATE TYPE "OilType" AS ENUM ('SYNTHETIC', 'SEMI_SYNTHETIC', 'MINERAL');

-- AlterTable: supply-side product
ALTER TABLE "products"
  ADD COLUMN "kind" "ProductKind" NOT NULL DEFAULT 'SPARE_PART',
  ADD COLUMN "oil_viscosity" VARCHAR(20),
  ADD COLUMN "oil_type" "OilType",
  -- Package volume in MILLILITRES, so it sorts/filters numerically; the "4 л"
  -- label shown to users is derived at render time, never stored.
  ADD COLUMN "oil_volume_ml" INTEGER;

-- AlterTable: in-progress wizard draft (mirrors the product columns so a
-- resumed or edited draft loses nothing).
ALTER TABLE "product_drafts"
  ADD COLUMN "kind" "ProductKind" NOT NULL DEFAULT 'SPARE_PART',
  ADD COLUMN "oil_viscosity" VARCHAR(20),
  ADD COLUMN "oil_type" "OilType",
  ADD COLUMN "oil_volume_ml" INTEGER;

-- AlterTable: buyer-facing read model (projected verbatim from products).
ALTER TABLE "catalog_parts"
  ADD COLUMN "kind" "ProductKind" NOT NULL DEFAULT 'SPARE_PART',
  ADD COLUMN "oil_viscosity" VARCHAR(20),
  ADD COLUMN "oil_type" "OilType",
  ADD COLUMN "oil_volume_ml" INTEGER;

-- CreateIndex: kind is a primary filter axis on both sides ("show me oils").
CREATE INDEX "products_kind_idx" ON "products"("kind");
CREATE INDEX "catalog_parts_kind_idx" ON "catalog_parts"("kind");
