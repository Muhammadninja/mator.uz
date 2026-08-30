-- Fiscal codes for the `antifreeze` category (operator-supplied).
--
-- Mirrors the entry added to CATEGORY_FISCAL_DATA in
-- src/prisma/seed-data/catalog-reference.seed.ts exactly, so a freshly seeded
-- database and a migrated one converge — the same contract the rest of
-- 20260811000000_add_fiscal_data follows.
--
-- Antifreeze is on the ORDINARY category fiscal path: its questionnaire asks a
-- weight, not an oil type, so `isFiscalizedByOilType` is false for it and these
-- are the codes its listings resolve to. Without them the checkout correctly
-- refused to fiscalize an antifreeze line rather than borrowing a motor-oil
-- MXIK; this is the row that makes those listings sellable.
--
-- Sold in ONE form, so only the "Штука" code exists: the bot never asks
-- "Штука / Комплект" for this category and the single code always applies.
--
-- WHERE mxik IS NULL: an operator's own entry is never overwritten by a
-- re-deploy, exactly as in the original fiscal-data migration.
UPDATE "part_categories" SET
  "mxik" = '03820001001000000',
  "package_code_single" = '1513835',
  "package_code_set" = NULL
WHERE "id" = 'antifreeze'
  AND "mxik" IS NULL;
