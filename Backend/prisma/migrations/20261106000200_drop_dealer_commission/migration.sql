-- Mator takes no commission from dealers (the business's decision, 2026-11-06): its income is
-- the service fee, and it keeps delivery, which it carries out itself. This removes the four
-- commission columns that 20261106000100_refunds_payouts_and_commission added, and nothing
-- else: order_items.seller_id, seller_payouts, financial_refund_allocations.amount_uzs, the
-- payout holds, the refund parts, the service fee, delivery and the audit trail all stay.
--
-- In this order, in the single transaction PostgreSQL runs a migration's statements in:
--   1. Refuse to go on if a commission was really recorded: a dealer rate other than 0, or an
--      order line or a refund allocation that carries a commission. Those values are history,
--      and they are not dropped without a separate decision to keep or archive them. A rate of
--      exactly 0 is not a commission and does not stop it. When this refuses, nothing changes,
--      and Prisma records the migration as failed: run the read-only checks first.
--   2. Drop the columns. No index, constraint, view or trigger uses them, and dropping a
--      column rewrites no table.
--
-- No order is recomputed: totals, the service fee, delivery and each line's total stay as
-- they were stored.

-- Guard
DO $$
DECLARE
  rated_dealers bigint;
  charged_lines bigint;
  refunded_shares bigint;
BEGIN
  SELECT count(*) INTO rated_dealers
    FROM "catalog_sellers"
   WHERE "commission_percent" IS NOT NULL AND "commission_percent" <> 0;
  SELECT count(*) INTO charged_lines
    FROM "order_items"
   WHERE "commission_percent" <> 0 OR "commission_uzs" <> 0;
  SELECT count(*) INTO refunded_shares
    FROM "financial_refund_allocations"
   WHERE "commission_uzs" <> 0;
  IF rated_dealers + charged_lines + refunded_shares > 0 THEN
    RAISE EXCEPTION 'Commission values are recorded (dealers with a rate: %, order lines: %, refund allocations: %). Keep or archive them before dropping these columns.',
      rated_dealers, charged_lines, refunded_shares;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "catalog_sellers" DROP COLUMN "commission_percent";

-- AlterTable
ALTER TABLE "financial_refund_allocations" DROP COLUMN "commission_uzs";

-- AlterTable
ALTER TABLE "order_items" DROP COLUMN "commission_percent",
DROP COLUMN "commission_uzs";
