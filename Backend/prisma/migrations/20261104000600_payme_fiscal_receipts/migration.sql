-- The fiscal receipts Payme reports through SetFiscalData.
--
-- The tax authority issues the sale and its cancellation as two separate receipts, so
-- the key is (payment, type): each has its own row, and a repeated callback has nowhere
-- to go but that same row.
--
-- Additive: one new enum and one new table, no backfill. Every field Payme sends may be
-- absent (a failed registration may have no fiscal sign), and its documentation fixes
-- neither a length nor the format of `date`, so they are stored as text, as they came.
--
-- Deploy before the code, which writes this table.
CREATE TYPE "PaymeFiscalReceiptType" AS ENUM ('PERFORM', 'CANCEL');

CREATE TABLE "payme_fiscal_receipts" (
    "payment_id" VARCHAR(64) NOT NULL,
    "type" "PaymeFiscalReceiptType" NOT NULL,
    "receipt_id" TEXT,
    "status_code" INTEGER,
    "message" TEXT,
    "terminal_id" TEXT,
    "fiscal_sign" TEXT,
    "qr_code_url" TEXT,
    "fiscal_date" TEXT,
    "raw_data" JSONB NOT NULL,
    "conflict_count" INTEGER NOT NULL DEFAULT 0,
    "last_conflict_data" JSONB,
    "last_conflict_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payme_fiscal_receipts_pkey" PRIMARY KEY ("payment_id","type")
);

ALTER TABLE "payme_fiscal_receipts"
  ADD CONSTRAINT "payme_fiscal_receipts_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
