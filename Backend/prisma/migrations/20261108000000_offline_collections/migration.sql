-- FIN-001. Additive only: a column with a constant default and a new table. No existing
-- row is rewritten, and application code from before this migration keeps working.
-- Deploy this migration BEFORE the application version that reads it.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "offline_collection_required" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "offline_collections" (
    "id" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "method" "PaymentType" NOT NULL,
    "amount_uzs" DECIMAL(14,2) NOT NULL,
    "reference" VARCHAR(120),
    "fiscal_reference" VARCHAR(120),
    "note" VARCHAR(500),
    "collected_at" TIMESTAMPTZ(3) NOT NULL,
    "collected_by_admin_id" VARCHAR(64) NOT NULL,
    "collected_by_name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offline_collections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offline_collections_order_id_key" ON "offline_collections"("order_id");

-- CreateIndex
CREATE INDEX "offline_collections_collected_at_idx" ON "offline_collections"("collected_at");

-- AddForeignKey
ALTER TABLE "offline_collections" ADD CONSTRAINT "offline_collections_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
