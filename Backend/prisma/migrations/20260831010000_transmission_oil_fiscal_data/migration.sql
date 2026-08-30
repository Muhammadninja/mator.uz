-- Fiscal codes for the `transmission-oil` category (operator-supplied).
--
-- Mirrors the entry added to CATEGORY_FISCAL_DATA in
-- src/prisma/seed-data/catalog-reference.seed.ts exactly, so a freshly seeded
-- database and a migrated one converge — the same contract
-- 20260811000000_add_fiscal_data and the antifreeze migration follow.
--
-- Transmission oil is the one option on the oil screen that is NOT a base
-- composition. Its three siblings (synthetic / semi-synthetic / mineral) resolve
-- their codes from the oilType they derive, which is why they carry none of
-- their own; transmission oil derives no oilType, so it is on the ORDINARY
-- category fiscal path and needs its own MXIK. Without this row the checkout
-- correctly refused to fiscalize a transmission-oil line rather than borrowing
-- a motor-oil MXIK — this is the row that makes those listings sellable.
--
-- Sold in ONE form, so only the "Штука" code exists: the bot never asks
-- "Штука / Комплект" for this category and the single code always applies.
--
-- Runs AFTER 20260831000000_motor_oil_type_categories, which is what guarantees
-- the row exists to update.
--
-- WHERE mxik IS NULL: an operator's own entry is never overwritten by a
-- re-deploy, exactly as in the original fiscal-data migration.
UPDATE "part_categories" SET
  "mxik" = '02710005005000000',
  "package_code_single" = '1282593',
  "package_code_set" = NULL
WHERE "id" = 'transmission-oil'
  AND "mxik" IS NULL;
