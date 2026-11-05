-- The receipt agreed for a Payme invoice, frozen when the invoice is created.
--
-- CheckPerformTransaction is where Payme takes the receipt from, and it carries only an
-- amount and an account, with no transaction id. So the receipt has to exist before it
-- is called and belongs to the invoice (a payments row), which CreateTransaction then
-- binds to the transaction. A change to a product, category, MXIK or VAT rate after that
-- reaches only the invoices issued later.
--
-- Additive: one new table, no backfill. An invoice row from before this holds no receipt
-- and is ignored, so the customer starts that payment again; a transaction already in
-- progress is not affected, since Perform and Cancel do not read it.
--
-- Deploy before the code, which reads and writes this table.
--
-- ── ON DELETE RESTRICT ──
-- Like the refund registry, this is the money trail: a payment holding a receipt cannot
-- be deleted. Nothing in the application deletes a payment.
CREATE TABLE "payme_fiscal_snapshots" (
    "payment_id" VARCHAR(64) NOT NULL,
    "detail" JSONB NOT NULL,
    "total_tiyin" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payme_fiscal_snapshots_pkey" PRIMARY KEY ("payment_id")
);

ALTER TABLE "payme_fiscal_snapshots"
  ADD CONSTRAINT "payme_fiscal_snapshots_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Immutability ──
-- A trigger, not a convention: the application has no code that updates this table, and
-- this keeps a later one, or a hand-run statement, from changing what was agreed. Hand
-- written, as Prisma's schema has no notion of triggers; `migrate diff` does not see it.
-- DELETE is not covered: the sandbox fixture's --reset needs it on its own test order.
CREATE FUNCTION "payme_fiscal_snapshots_refuse_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The fiscal snapshot of payment % is immutable', OLD."payment_id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payme_fiscal_snapshots_immutable"
  BEFORE UPDATE ON "payme_fiscal_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "payme_fiscal_snapshots_refuse_update"();
