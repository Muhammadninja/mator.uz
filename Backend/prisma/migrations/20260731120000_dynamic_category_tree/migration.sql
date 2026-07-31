-- Dynamic category tree: make PartCategory the source of truth for the SUPPLY
-- side (Product / ProductDraft) too, so the Admin Panel can edit the taxonomy
-- the Telegram seller bot offers without a code change or redeploy.
--
-- STAGED AND ADDITIVE. This migration:
--   • adds part_categories.level (derived depth),
--   • promotes the 8 PartVehicleCategory enum values to level-0 ROOT rows,
--   • re-parents the 12 canonical level-1 main categories under those roots
--     using the mapping the wizard already ships (wizard-catalog.ts SUBCATEGORIES),
--   • adds nullable category_id / vehicle_category_id to products + product_drafts
--     and BACKFILLS them from the existing enum columns.
--
-- It does NOT drop `main_category` / `vehicle_category` from any table. Those
-- enums stay authoritative for the classifier, the buyer projection and the
-- public ?main_category= filter; the new ids are written alongside them. Dropping
-- them is a separate, later stage once every consumer reads ids — keeping them
-- here is what makes this migration rollback-safe.
--
-- Hand-written, IDEMPOTENT and safe to re-run: every step guards its own
-- existence (IF NOT EXISTS / ON CONFLICT / WHERE ... IS NULL). It does NOT assume
-- the database is empty — every backfill is written against whatever rows exist.

-- ── 1. part_categories.level ────────────────────────────────────────────────
ALTER TABLE "part_categories" ADD COLUMN IF NOT EXISTS "level" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "part_categories_level_idx" ON "part_categories" ("level");
CREATE INDEX IF NOT EXISTS "part_categories_is_active_idx" ON "part_categories" ("is_active");

-- ── 2. Vehicle categories → level-0 ROOT rows ───────────────────────────────
-- Values and display names verbatim from VEHICLE_CATEGORIES in
-- src/catalog/categories/part-categories.catalog.ts; ids are the existing slugs.
-- These become the roots the seller bot's first category step lists.
INSERT INTO "part_categories" ("id", "name", "slug", "color", "icon_key", "main_category", "level", "sort_order", "is_active", "created_at", "updated_at")
VALUES
  ('brake-system',             'Brake System',            'brake-system',             '#EA4335', 'brakes',       NULL, 0, 0, true, now(), now()),
  ('maintenance-and-fluids',   'Maintenance & Fluids',    'maintenance-and-fluids',   '#00ACC1', 'oil',          NULL, 0, 1, true, now(), now()),
  ('suspension-and-steering',  'Suspension & Steering',   'suspension-and-steering',  '#009688', 'suspension',   NULL, 0, 2, true, now(), now()),
  ('electrical-and-lighting',  'Electrical & Lighting',   'electrical-and-lighting',  '#A142F4', 'electrical',   NULL, 0, 3, true, now(), now()),
  ('engine-system',            'Engine',                  'engine-system',            '#4285F4', 'engine',       NULL, 0, 4, true, now(), now()),
  ('transmission',             'Transmission',            'transmission',             '#3F51B5', 'transmission', NULL, 0, 5, true, now(), now()),
  ('heating-and-cooling',      'Heating & Cooling',       'heating-and-cooling',      '#03A9F4', 'cooling',      NULL, 0, 6, true, now(), now()),
  ('tuning-and-accessories',   'Tuning & Accessories',    'tuning-and-accessories',   '#9C27B0', 'tuning',       NULL, 0, 7, true, now(), now())
ON CONFLICT ("id") DO UPDATE SET
  "name"       = EXCLUDED."name",
  "slug"       = EXCLUDED."slug",
  "color"      = EXCLUDED."color",
  "icon_key"   = EXCLUDED."icon_key",
  "level"      = 0,
  "parent_id"  = NULL,
  "is_active"  = true,
  "updated_at" = now();

-- NOTE on 'engine-system': the level-1 main category BRAKES→'engine' already owns
-- the id 'engine' (PartMainCategory.ENGINE), so the ROOT vehicle category
-- PartVehicleCategory.ENGINE cannot reuse it. It takes 'engine-system' instead.
-- The enum→id mapping below is what preserves the distinction; nothing infers a
-- category id from a name.

-- ── 3. Re-parent the 12 canonical main categories under their vehicle root ──
-- Mapping is verbatim from SUBCATEGORIES in src/telegram/wizard-catalog.ts — the
-- pairing the bot has been offering sellers all along. Only rows that are still
-- unparented are touched, so an admin who has since moved a category keeps it.
UPDATE "part_categories" SET "parent_id" = 'brake-system',            "level" = 1, "updated_at" = now() WHERE "id" = 'brakes'           AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'maintenance-and-fluids',  "level" = 1, "updated_at" = now() WHERE "id" = 'filters'          AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'maintenance-and-fluids',  "level" = 1, "updated_at" = now() WHERE "id" = 'oil-and-fluids'   AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'maintenance-and-fluids',  "level" = 1, "updated_at" = now() WHERE "id" = 'wipers'           AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'suspension-and-steering', "level" = 1, "updated_at" = now() WHERE "id" = 'suspension'       AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'electrical-and-lighting', "level" = 1, "updated_at" = now() WHERE "id" = 'batteries'        AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'electrical-and-lighting', "level" = 1, "updated_at" = now() WHERE "id" = 'electrical-parts' AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'electrical-and-lighting', "level" = 1, "updated_at" = now() WHERE "id" = 'ignition'         AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'electrical-and-lighting', "level" = 1, "updated_at" = now() WHERE "id" = 'lighting'         AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'engine-system',           "level" = 1, "updated_at" = now() WHERE "id" = 'engine'           AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'engine-system',           "level" = 1, "updated_at" = now() WHERE "id" = 'belts-and-hoses'  AND "parent_id" IS NULL;
UPDATE "part_categories" SET "parent_id" = 'tuning-and-accessories',  "level" = 1, "updated_at" = now() WHERE "id" = 'exterior'         AND "parent_id" IS NULL;

-- TRANSMISSION and HEATING_AND_COOLING intentionally get no children: they have
-- none in the wizard today, and the bot's "no active children → skip the step"
-- rule means a seller picking them goes straight on to TITLE. The Admin Panel can
-- add children later and the bot picks them up with no redeploy.

-- Any remaining unparented, non-root row (legacy seed leftovers) keeps level 0.
-- Rows that DO have a parent but were created before this column existed get a
-- level derived from their depth, one pass per level (the tree is 3 deep).
UPDATE "part_categories" c SET "level" = p."level" + 1
  FROM "part_categories" p
 WHERE c."parent_id" = p."id" AND c."level" <> p."level" + 1;
UPDATE "part_categories" c SET "level" = p."level" + 1
  FROM "part_categories" p
 WHERE c."parent_id" = p."id" AND c."level" <> p."level" + 1;
UPDATE "part_categories" c SET "level" = p."level" + 1
  FROM "part_categories" p
 WHERE c."parent_id" = p."id" AND c."level" <> p."level" + 1;

-- The 'cat_uncategorized' fallback is an internal bucket for unclassified buyer
-- parts, NOT a taxonomy the seller should be offered. Park it at level 1 under
-- no parent so it never appears among the root categories the bot lists, while
-- staying available as a catalog_parts.category_id target.
UPDATE "part_categories" SET "level" = 1, "updated_at" = now()
 WHERE "id" = 'cat_uncategorized' AND "parent_id" IS NULL;

-- ── 4. Supply-side FK columns ───────────────────────────────────────────────
ALTER TABLE "products"        ADD COLUMN IF NOT EXISTS "category_id"         VARCHAR(64);
ALTER TABLE "products"        ADD COLUMN IF NOT EXISTS "vehicle_category_id" VARCHAR(64);
ALTER TABLE "product_drafts"  ADD COLUMN IF NOT EXISTS "category_id"         VARCHAR(64);
ALTER TABLE "product_drafts"  ADD COLUMN IF NOT EXISTS "vehicle_category_id" VARCHAR(64);

-- ON DELETE SET NULL: removing a category must never make a listing unreadable.
DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "part_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_vehicle_category_id_fkey"
    FOREIGN KEY ("vehicle_category_id") REFERENCES "part_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_drafts" ADD CONSTRAINT "product_drafts_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "part_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "product_drafts" ADD CONSTRAINT "product_drafts_vehicle_category_id_fkey"
    FOREIGN KEY ("vehicle_category_id") REFERENCES "part_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "products_category_id_idx"                ON "products" ("category_id");
CREATE INDEX IF NOT EXISTS "products_vehicle_category_id_idx"        ON "products" ("vehicle_category_id");
CREATE INDEX IF NOT EXISTS "product_drafts_category_id_idx"          ON "product_drafts" ("category_id");
CREATE INDEX IF NOT EXISTS "product_drafts_vehicle_category_id_idx"  ON "product_drafts" ("vehicle_category_id");

-- ── 5. Backfill from the enum columns ───────────────────────────────────────
-- Enum → root id. Mirrors VEHICLE_CATEGORIES; ENGINE → 'engine-system' (see the
-- note in step 2). Only fills rows that have no id yet, so re-running is a no-op
-- and a value an admin has since corrected is never overwritten.
UPDATE "products" SET "vehicle_category_id" = CASE "vehicle_category"
    WHEN 'BRAKE_SYSTEM'            THEN 'brake-system'
    WHEN 'MAINTENANCE_AND_FLUIDS'  THEN 'maintenance-and-fluids'
    WHEN 'SUSPENSION_AND_STEERING' THEN 'suspension-and-steering'
    WHEN 'ELECTRICAL_AND_LIGHTING' THEN 'electrical-and-lighting'
    WHEN 'ENGINE'                  THEN 'engine-system'
    WHEN 'TRANSMISSION'            THEN 'transmission'
    WHEN 'HEATING_AND_COOLING'     THEN 'heating-and-cooling'
    WHEN 'TUNING_AND_ACCESSORIES'  THEN 'tuning-and-accessories'
  END
 WHERE "vehicle_category" IS NOT NULL AND "vehicle_category_id" IS NULL;

-- main_category enum → its canonical level-1 row. The join goes through
-- part_categories.main_category (only the 12 canonical rows carry it), so the
-- target is unambiguous and survives an admin renaming a category.
UPDATE "products" p SET "category_id" = c."id"
  FROM "part_categories" c
 WHERE c."main_category" = p."main_category"
   AND p."main_category" IS NOT NULL
   AND p."category_id" IS NULL;

UPDATE "product_drafts" SET "vehicle_category_id" = CASE "category"
    WHEN 'BRAKE_SYSTEM'            THEN 'brake-system'
    WHEN 'MAINTENANCE_AND_FLUIDS'  THEN 'maintenance-and-fluids'
    WHEN 'SUSPENSION_AND_STEERING' THEN 'suspension-and-steering'
    WHEN 'ELECTRICAL_AND_LIGHTING' THEN 'electrical-and-lighting'
    WHEN 'ENGINE'                  THEN 'engine-system'
    WHEN 'TRANSMISSION'            THEN 'transmission'
    WHEN 'HEATING_AND_COOLING'     THEN 'heating-and-cooling'
    WHEN 'TUNING_AND_ACCESSORIES'  THEN 'tuning-and-accessories'
  END
 WHERE "category" IS NOT NULL AND "vehicle_category_id" IS NULL;

-- Drafts store the seller's explicit subcategory pick in `subcategory`.
UPDATE "product_drafts" d SET "category_id" = c."id"
  FROM "part_categories" c
 WHERE c."main_category" = d."subcategory"
   AND d."subcategory" IS NOT NULL
   AND d."category_id" IS NULL;
