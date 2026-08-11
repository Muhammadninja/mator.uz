-- Fiscal data for Payme receipts: Tasnif codes on the CATEGORY, tax identity on
-- the DEALER, and the per-listing sale form that picks between the category's
-- two package codes.
--
-- Purely ADDITIVE and non-destructive. One new enum type and seven new NULLABLE
-- columns across five existing tables; nothing is dropped, renamed, retyped or
-- backfilled from a guess. Every existing row keeps its current meaning and
-- every current query returns exactly what it returned before.
--
-- ── Why every column is nullable ──
-- Existing categories and dealers predate fiscal configuration, so a NOT NULL
-- column would either fail on live rows or force an invented default. Both are
-- unacceptable here: an invented MXIK or a defaulted 0% VAT would be sent to
-- the tax authority as if it were real. NULL means "not configured yet" and is
-- what the checkout gate reads to refuse an item rather than fiscalize it
-- wrongly. The business rule ("a configured category has BOTH mxik and
-- package_code_single") is enforced by the admin write path — see
-- AdminCategoriesService — not by a CHECK constraint: Prisma cannot express a
-- CHECK in schema.prisma, so a hand-written one would show up as permanent
-- drift in every future `migrate diff` (the same reasoning as the curated
-- ratings migration).

-- CreateEnum: which of a category's two package codes fiscalizes a listing.
CREATE TYPE "PackageForm" AS ENUM ('SINGLE', 'SET');

-- AlterTable: the category owns the fiscal codes shared by all of its products.
ALTER TABLE "part_categories"
  ADD COLUMN "mxik" VARCHAR(17),
  ADD COLUMN "package_code_single" VARCHAR(20),
  ADD COLUMN "package_code_set" VARCHAR(20);

-- AlterTable: the dealer owns its tax identity. tin is TEXT, not a numeric
-- type — leading zeros are significant and the column holds a 9-digit ИНН or a
-- 14-digit ПИНФЛ.
ALTER TABLE "catalog_sellers"
  ADD COLUMN "tin" VARCHAR(14),
  ADD COLUMN "vat_percent" DECIMAL(5,2);

-- AlterTable: the listing's own sale form — the ONLY fiscal fact a product
-- carries. It selects one of the category's codes rather than copying it, so an
-- admin correcting a code fixes every product at once.
ALTER TABLE "products"       ADD COLUMN "package_form" "PackageForm";
ALTER TABLE "product_drafts" ADD COLUMN "package_form" "PackageForm";
ALTER TABLE "catalog_parts"  ADD COLUMN "package_form" "PackageForm";

-- ── Initial category configuration ────────────────────────────────────────────
-- The known MXIK/package codes, applied to the SELECTABLE (leaf) category each
-- one describes. Mirrors CATEGORY_FISCAL_DATA in
-- src/prisma/seed-data/catalog-reference.seed.ts exactly, so a fresh (seeded)
-- database and a migrated one converge — the same contract the category-tree
-- migrations already follow.
--
-- Matched by STABLE ID, never by name, and only onto leaves: a seller's listing
-- always lands on a leaf (selectCategory keeps the root only when it has no
-- children), so configuring a parent would leave the codes unreachable. That is
-- why "Brake system" configures 'brakes' (the sole leaf under 'brake-system')
-- while "Transmission" and "A/C" configure the childless roots 'transmission'
-- and 'heating-and-cooling' directly.
--
-- WHERE mxik IS NULL: an operator's own entry is never overwritten by a
-- re-deploy. Categories absent from the supplied list (the oil categories, the
-- "Другое" children, the fallback bucket) are deliberately left unconfigured —
-- codes are never invented.
UPDATE "part_categories" SET
  "mxik" = v.mxik,
  "package_code_single" = v.single,
  "package_code_set" = v.set_code
FROM (VALUES
  -- id,                     mxik,                 single,     set
  ('brakes',              '08708005011000000', '1417722', '1417723'),
  ('transmission',        '08708006003000000', '1417580', '1417581'),
  ('suspension',          '08708009002000000', '1417721', '1417718'),
  ('filters',             '08421002001000000', '1499205', NULL),
  ('wipers',              '08512900001000000', '1866417', NULL),
  ('batteries',           '08507001009000000', '1431941', NULL),
  ('ignition',            '08511001002000000', '1350138', NULL),
  ('electrical-parts',    '08511001001000000', '1350563', NULL),
  ('lighting',            '08512001010000000', '1350743', NULL),
  ('engine',              '08407001001000000', '1444123', NULL),
  ('belts-and-hoses',     '04009001012000000', '1342595', NULL),
  ('heating-and-cooling', '08415001012000000', '1462732', NULL),
  ('exterior',            '08708002001000000', '1417557', NULL)
) AS v(id, mxik, single, set_code)
WHERE "part_categories"."id" = v.id
  AND "part_categories"."mxik" IS NULL;
