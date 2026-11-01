-- The registry of money actually returned to customers (financial_refunds), plus
-- orders.refund_settled_at, which says the registry accounts for all an order took.
--
-- Additive: a new table, a nullable column with no default (a catalog-only change,
-- no table rewrite) and new enum values. No existing row is touched, and an older
-- build keeps working, since it never reads or writes any of this. The foreign keys
-- are created on an empty table, so they hold their locks only for a moment.
--
-- The audit enum values are added without being used here, for the reason given in
-- 20260728000000_dealer_audit_enum_values. IF NOT EXISTS makes a re-run a no-op.
CREATE TYPE "RefundMethod" AS ENUM ('PROVIDER', 'TERMINAL', 'CASH', 'BANK_TRANSFER');

CREATE TYPE "RefundSource" AS ENUM ('MANUAL', 'PROVIDER_CALLBACK');

ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'REFUND_RECORDED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'REFUND_VOIDED';

ALTER TABLE "orders" ADD COLUMN     "refund_settled_at" TIMESTAMPTZ(3);

CREATE TABLE "financial_refunds" (
    "id" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "payment_id" VARCHAR(64),
    "amount_uzs" DECIMAL(14,2) NOT NULL,
    "method" "RefundMethod" NOT NULL,
    "source" "RefundSource" NOT NULL DEFAULT 'MANUAL',
    "reference" VARCHAR(120) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "refunded_at" TIMESTAMPTZ(3) NOT NULL,
    "provider_confirmed_at" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_by_email" VARCHAR(255),
    "created_by_name" VARCHAR(120),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_id" TEXT,
    "voided_by_email" VARCHAR(255),
    "void_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "financial_refunds_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "financial_refunds_order_id_idx" ON "financial_refunds"("order_id");

CREATE INDEX "financial_refunds_payment_id_idx" ON "financial_refunds"("payment_id");

CREATE INDEX "financial_refunds_refunded_at_idx" ON "financial_refunds"("refunded_at");

ALTER TABLE "financial_refunds" ADD CONSTRAINT "financial_refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "financial_refunds" ADD CONSTRAINT "financial_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
