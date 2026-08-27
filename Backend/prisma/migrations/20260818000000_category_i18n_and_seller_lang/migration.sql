-- ─────────────────────────────────────────────────────────────────────────────
-- Category names become fully localized (ru / uz / en, all REQUIRED), and a
-- seller gets a bot interface language.
--
-- ORDER MATTERS: every column is created/renamed and BACKFILLED before it is
-- made NOT NULL, so the migration is safe on a live table with existing rows.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. The two existing localized columns are RENAMED, not recreated — renaming
--    preserves the translations already entered (title_ru/title_uz were added
--    by 20260816000000_add_category_titles and seeded for ~60 categories).
ALTER TABLE "part_categories" RENAME COLUMN "title_ru" TO "name_ru";
ALTER TABLE "part_categories" RENAME COLUMN "title_uz" TO "name_uz";

-- 2. English is new. Added nullable so the table stays writable during backfill.
ALTER TABLE "part_categories" ADD COLUMN "name_en" VARCHAR(160);

-- 3. Backfill. A row missing a translation (or holding a blank one) falls back
--    to the canonical `name`, which is never null — so no row can be left
--    without a display name in any language. `name` is already English for the
--    seeded buyer buckets ("Brakes", "Filters", …), which makes it the correct
--    seed for name_en specifically.
UPDATE "part_categories"
   SET "name_ru" = COALESCE(NULLIF(BTRIM("name_ru"), ''), "name"),
       "name_uz" = COALESCE(NULLIF(BTRIM("name_uz"), ''), "name"),
       "name_en" = COALESCE(NULLIF(BTRIM("name_en"), ''), "name");

-- 4. Now that no NULLs remain, enforce the contract in the DB itself: a
--    category ALWAYS has all three names. This is the backstop behind the DTO
--    validation — a write path that forgets one fails loudly instead of
--    producing a category that renders blank in one language.
ALTER TABLE "part_categories" ALTER COLUMN "name_ru" SET NOT NULL;
ALTER TABLE "part_categories" ALTER COLUMN "name_uz" SET NOT NULL;
ALTER TABLE "part_categories" ALTER COLUMN "name_en" SET NOT NULL;

-- 5. Seller bot language. NULLABLE with no default: null = "has not chosen
--    yet", which is what makes the bot show the language picker on /start
--    exactly once. Existing sellers therefore get asked on their next /start.
CREATE TYPE "BotLanguage" AS ENUM ('RU', 'UZ', 'EN');
ALTER TABLE "sellers" ADD COLUMN "lang" "BotLanguage";
