-- The service fee itself needs no column: orders.service_fee_uzs has been there all along,
-- and order creation now fills it. These two keep the fee apart from everyone else's money.
--
-- financial_refunds.service_fee_uzs: how much of a refund is the fee going back, so what
-- stays with Mator can be told from what went back to the buyer.
--
-- order_items.seller_id: the storefront that sold the line, as it stood when the order was
-- placed, so what each seller is owed does not depend on a catalog row that can be delisted
-- or change hands. A plain id with no foreign key, like part_id. Existing lines stay NULL and
-- read as unattributed: there is no backfill, because the catalog as it stands today is not
-- proof of who sold a line then.
--
-- Additive: a nullable column, and a NOT NULL column with a constant default. Neither rewrites
-- the table, and an older build keeps working, since it never reads or writes either.
--
-- Deploy before the code, which reads and writes both.

-- AlterTable
ALTER TABLE "financial_refunds" ADD COLUMN     "service_fee_uzs" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "seller_id" VARCHAR(64);
