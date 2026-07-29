-- Sales (automatic discounts). Purely ADDITIVE: two new enums and two new
-- tables. No existing table, column, index or constraint is altered, renamed or
-- dropped, so every current endpoint keeps its exact behaviour.
--
-- In particular the promo-code system is untouched: carts.promo_code and
-- carts.promo_discount_uzs keep their shape and their code path. A sale is a
-- different mechanism (admin-created, auto-applied, per product) and shares no
-- storage with promo codes.

-- CreateEnum
CREATE TYPE "SaleDiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
-- Scope kinds. A future scope (brand, vehicle make, price band) is added by
-- appending a value here — sale_targets.target_id is an unconstrained id column
-- precisely so a new kind needs no new table and no backfill of existing rows.
CREATE TYPE "SaleScopeType" AS ENUM ('ALL_PRODUCTS', 'PRODUCTS', 'CATEGORIES', 'DEALERS');

-- CreateTable
CREATE TABLE "sales" (
    "id" VARCHAR(64) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(1000),
    "discount_type" "SaleDiscountType" NOT NULL,
    "discount_value" DECIMAL(14,2) NOT NULL,
    "scope_type" "SaleScopeType" NOT NULL DEFAULT 'ALL_PRODUCTS',
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    -- Soft delete: DELETE stamps this instead of removing the row, so a campaign
    -- that ran stays on file. NULL = not deleted.
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- One row per selected product / category / dealer. target_id carries no FK:
-- the three kinds live in three different tables and no single FK can point at
-- all of them. Existence is validated by the service at write time.
CREATE TABLE "sale_targets" (
    "id" VARCHAR(64) NOT NULL,
    "sale_id" VARCHAR(64) NOT NULL,
    "target_type" "SaleScopeType" NOT NULL,
    "target_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Covers the active-sale lookup both endpoints run: the two flags (most
-- selective), then the window.
CREATE INDEX "sales_deleted_at_is_active_start_at_end_at_idx" ON "sales"("deleted_at", "is_active", "start_at", "end_at");

-- CreateIndex
CREATE INDEX "sale_targets_sale_id_idx" ON "sale_targets"("sale_id");

-- CreateIndex
-- "which sales target this product/category/dealer" — the discount resolution.
CREATE INDEX "sale_targets_target_type_target_id_idx" ON "sale_targets"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_targets_sale_id_target_type_target_id_key" ON "sale_targets"("sale_id", "target_type", "target_id");

-- AddForeignKey
-- Cascade: deleting a sale removes its targets, never orphans them.
ALTER TABLE "sale_targets" ADD CONSTRAINT "sale_targets_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
