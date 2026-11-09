-- Fiscal codes are entered by hand by an admin, so a separate confirmation of them is not
-- kept any more (the business's decision, 2026-11-09): a category's mxik and package codes are
-- what a receipt carries. Past confirmations stay readable in admin_audits, as
-- CATEGORY_FISCAL_CONFIRMED / CATEGORY_FISCAL_UNCONFIRMED.
--
-- No index, constraint, view or trigger uses this column. Deploy the code first: the previous
-- build selects it.

-- AlterTable
ALTER TABLE "part_categories" DROP COLUMN "fiscal_confirmed_codes";
