-- The money side of an order, kept apart by whose it is.
--
-- catalog_sellers.commission_percent: Mator's commission on a dealer's goods, by contract.
-- NULL is "not configured", which charges 0% by the business's decision. No global rate.
--
-- order_items.commission_percent / commission_uzs: the rate an order was placed under and
-- what it came to on each line, frozen at creation, so changing a dealer's rate reaches new
-- orders only. Existing lines get 0, which is what they were charged.
--
-- orders.payout_hold_at / payout_hold_reason: sellers are not paid for an order while a
-- cancellation or return is under way.
--
-- financial_refunds.delivery_uzs: how much of a refund is delivery going back, beside the
-- service fee share (service_fee_uzs, 20261105000200). What is left of a refund is goods.
--
-- financial_refunds.fiscal_reference: the return receipt a cash register or the OFD issued
-- for a refund made outside a provider, as an operator states it.
--
-- financial_refund_allocations: whose goods a refund gave money back for, per seller, with the
-- commission that went with them, so what Mator owes each seller can be told.
--
-- seller_payouts: money Mator sent a seller. Voided, never deleted.
--
-- Additive: nullable columns and NOT NULL columns with a constant default (no table rewrite),
-- two new tables and an enum. Existing refunds keep a delivery share of 0 and no allocations,
-- and read as unattributed goods. No backfill: a past refund cannot be told to have been for
-- one seller's goods after the fact.
--
-- Deploy after 20261106000000 and before the code, which reads and writes all of this.

-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('BANK_TRANSFER', 'CASH');

-- AlterTable
ALTER TABLE "catalog_sellers" ADD COLUMN     "commission_percent" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payout_hold_at" TIMESTAMPTZ(3),
ADD COLUMN     "payout_hold_reason" VARCHAR(500);

-- AlterTable
ALTER TABLE "financial_refunds" ADD COLUMN     "delivery_uzs" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "fiscal_reference" VARCHAR(120);

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "commission_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "commission_uzs" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "financial_refund_allocations" (
    "id" VARCHAR(64) NOT NULL,
    "refund_id" VARCHAR(64) NOT NULL,
    "seller_id" VARCHAR(64) NOT NULL,
    "amount_uzs" DECIMAL(14,2) NOT NULL,
    "commission_uzs" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_refund_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_payouts" (
    "id" VARCHAR(64) NOT NULL,
    "seller_id" VARCHAR(64) NOT NULL,
    "amount_uzs" DECIMAL(14,2) NOT NULL,
    "method" "PayoutMethod" NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "note" VARCHAR(500),
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_id" TEXT,
    "created_by_email" VARCHAR(255),
    "created_by_name" VARCHAR(120),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_id" TEXT,
    "voided_by_email" VARCHAR(255),
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "seller_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "financial_refund_allocations_seller_id_idx" ON "financial_refund_allocations"("seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_refund_allocations_refund_id_seller_id_key" ON "financial_refund_allocations"("refund_id", "seller_id");

-- CreateIndex
CREATE INDEX "seller_payouts_seller_id_idx" ON "seller_payouts"("seller_id");

-- CreateIndex
CREATE INDEX "seller_payouts_paid_at_idx" ON "seller_payouts"("paid_at");

-- AddForeignKey
ALTER TABLE "financial_refund_allocations" ADD CONSTRAINT "financial_refund_allocations_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "financial_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
