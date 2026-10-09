-- Driver's Village 1C import: keep the source part number verbatim.
--
-- Purely ADDITIVE: one nullable column, no default, no backfill. Every
-- existing row reads NULL ("no source part number"), which is exactly right for
-- Telegram listings, so no existing behaviour changes.
--
--   • products.source_part_number — the `manufacturer_part_number` cell of the
--     1C export exactly as the file holds it: one string, never split on
--     spaces, never normalized, trimmed or case-changed. Cyrillic, mixed
--     alphabets, inner spaces and punctuation are stored as given. TEXT, so no
--     length can truncate it. products.oem_numbers stays the normalized search
--     index derived from it; it is not a copy of the source value.
--
-- Lock profile: ADD COLUMN without a default is a catalog-only change.
--
-- DEPLOY ORDER: apply BEFORE deploying the code that reads this column (the
-- importer and the generated Prisma client select it).

-- AlterTable
ALTER TABLE "products" ADD COLUMN "source_part_number" TEXT;
