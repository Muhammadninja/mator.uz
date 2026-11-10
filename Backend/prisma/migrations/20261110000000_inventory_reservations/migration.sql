-- P2.1 inventory reservations. Additive only: one column with a constant default, new
-- enums, two new tables and new enum values on the admin audit. No existing row is
-- rewritten, no reservation is invented for an order placed before this, and application
-- code from before this migration keeps working.
-- Deploy this BEFORE the application version that reads it: every catalog read selects
-- catalog_parts.reserved_qty. INVENTORY_RESERVATIONS_ENABLED stays off until this is
-- verified. Needs PostgreSQL 12+ for ALTER TYPE ... ADD VALUE inside a transaction.


-- CreateEnum
CREATE TYPE "InventoryReservationStatus" AS ENUM ('HELD', 'ALLOCATED', 'RELEASED', 'RECONCILED');

-- CreateEnum
CREATE TYPE "InventoryReconciliationSource" AS ENUM ('SOURCE_IMPORT', 'OPERATOR');

-- CreateEnum
CREATE TYPE "StockShortageCause" AS ENUM ('SOURCE_STOCK', 'MATOR_RESERVATIONS');

-- AlterEnum


ALTER TYPE "AdminAuditAction" ADD VALUE 'INVENTORY_RESERVATION_RECONCILED';
ALTER TYPE "AdminAuditAction" ADD VALUE 'INVENTORY_RESERVATION_RELEASED';
ALTER TYPE "AdminAuditAction" ADD VALUE 'INVENTORY_RESERVATION_RESTOCKED';

-- AlterTable
ALTER TABLE "catalog_parts" ADD COLUMN     "reserved_qty" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(64),
    "order_item_id" VARCHAR(64),
    "part_id" VARCHAR(64),
    "stock_id" INTEGER,
    "order_ref" VARCHAR(64) NOT NULL,
    "order_item_ref" VARCHAR(64) NOT NULL,
    "part_ref" VARCHAR(64) NOT NULL,
    "seller_id" VARCHAR(64) NOT NULL,
    "seller_name" VARCHAR(255) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "part_numbers" TEXT[],
    "quantity" INTEGER NOT NULL,
    "reconciled_qty" INTEGER NOT NULL DEFAULT 0,
    "restocked_qty" INTEGER NOT NULL DEFAULT 0,
    "status" "InventoryReservationStatus" NOT NULL DEFAULT 'HELD',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),
    "allocated_at" TIMESTAMPTZ(3),
    "fulfilled_at" TIMESTAMPTZ(3),
    "return_pending_at" TIMESTAMPTZ(3),
    "released_at" TIMESTAMPTZ(3),
    "release_reason" VARCHAR(500),
    "reconciled_at" TIMESTAMPTZ(3),
    "reconciliation_source" "InventoryReconciliationSource",
    "reconciliation_ref" VARCHAR(500),
    "reconciliation_note" VARCHAR(500),

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_shortage_attempts" (
    "id" VARCHAR(64) NOT NULL,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "cart_item_ref" VARCHAR(64) NOT NULL,
    "part_id" VARCHAR(64) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "part_numbers" TEXT[],
    "seller_id" VARCHAR(64) NOT NULL,
    "seller_name" VARCHAR(255) NOT NULL,
    "requested_qty" INTEGER NOT NULL,
    "reported_qty" INTEGER NOT NULL,
    "held_qty" INTEGER NOT NULL,
    "allocated_qty" INTEGER NOT NULL,
    "available_qty" INTEGER NOT NULL,
    "cause" "StockShortageCause" NOT NULL,
    "alternatives_count" INTEGER NOT NULL DEFAULT 0,
    "sourcing_ticket_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_shortage_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_order_item_id_key" ON "inventory_reservations"("order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_order_item_ref_key" ON "inventory_reservations"("order_item_ref");

-- CreateIndex
CREATE INDEX "inventory_reservations_order_id_idx" ON "inventory_reservations"("order_id");

-- CreateIndex
CREATE INDEX "inventory_reservations_part_id_status_idx" ON "inventory_reservations"("part_id", "status");

-- CreateIndex
CREATE INDEX "inventory_reservations_stock_id_status_idx" ON "inventory_reservations"("stock_id", "status");

-- CreateIndex
CREATE INDEX "inventory_reservations_seller_id_status_idx" ON "inventory_reservations"("seller_id", "status");

-- CreateIndex
CREATE INDEX "inventory_reservations_status_created_at_idx" ON "inventory_reservations"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_shortage_attempts_dedupe_key_key" ON "stock_shortage_attempts"("dedupe_key");

-- CreateIndex
CREATE INDEX "stock_shortage_attempts_created_at_idx" ON "stock_shortage_attempts"("created_at");

-- CreateIndex
CREATE INDEX "stock_shortage_attempts_part_id_idx" ON "stock_shortage_attempts"("part_id");

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "catalog_parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_stock_id_fkey" FOREIGN KEY ("stock_id") REFERENCES "stocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- What Prisma cannot declare: a promised quantity is never negative, and a reservation
-- never settles more than it holds.
ALTER TABLE "catalog_parts" ADD CONSTRAINT "catalog_parts_reserved_qty_non_negative" CHECK ("reserved_qty" >= 0);
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_quantities_valid"
  CHECK ("quantity" > 0 AND "reconciled_qty" >= 0 AND "restocked_qty" >= 0 AND "reconciled_qty" + "restocked_qty" <= "quantity");
