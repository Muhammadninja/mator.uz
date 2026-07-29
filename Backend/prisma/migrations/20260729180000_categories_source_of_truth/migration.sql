-- Categories: make PartCategory the single source of truth for the buyer grid.
--
-- This migration is hand-written, IDEMPOTENT and safe to re-run: every step
-- guards its own existence (IF NOT EXISTS / ON CONFLICT / conditional UPDATE),
-- and `prisma migrate deploy` wraps the file in a transaction on the server.
--
-- Steps:
--   a. Add color / icon_key / is_active / main_category columns.
--   b. UPSERT the 12 canonical category rows (id = slug, main_category = enum).
--   c. Ensure the 'cat_uncategorized' fallback row exists.
--   d. BACKFILL catalog_parts.category_id from the classified main_category
--      (the critical step) — enum → slug, unclassified → 'cat_uncategorized'.
--   e. Deactivate old orphan seed rows (not among the 12 + fallback).

-- ── a. Columns ───────────────────────────────────────────────────────────────
ALTER TABLE "part_categories" ADD COLUMN IF NOT EXISTS "color" VARCHAR(16);
ALTER TABLE "part_categories" ADD COLUMN IF NOT EXISTS "icon_key" VARCHAR(48);
ALTER TABLE "part_categories" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "part_categories" ADD COLUMN IF NOT EXISTS "main_category" "PartMainCategory";

CREATE INDEX IF NOT EXISTS "part_categories_main_category_idx" ON "part_categories" ("main_category");

-- ── b. The 12 canonical rows (values verbatim from part-categories.catalog.ts) ─
-- id = slug, sort_order = display index, main_category = the mirrored enum.
INSERT INTO "part_categories" ("id", "name", "slug", "color", "icon_key", "main_category", "sort_order", "is_active", "created_at", "updated_at")
VALUES
  ('brakes',          'Brakes',           'brakes',          '#EA4335', 'brakes',     'BRAKES',           0,  true, now(), now()),
  ('batteries',       'Batteries',        'batteries',       '#FBBC04', 'batteries',  'BATTERIES',        1,  true, now(), now()),
  ('filters',         'Filters',          'filters',         '#34A853', 'filters',    'FILTERS',          2,  true, now(), now()),
  ('ignition',        'Ignition',         'ignition',        '#FF6D01', 'ignition',   'IGNITION',         3,  true, now(), now()),
  ('engine',          'Engine',           'engine',          '#4285F4', 'engine',     'ENGINE',           4,  true, now(), now()),
  ('electrical-parts','Electrical Parts', 'electrical-parts','#A142F4', 'electrical', 'ELECTRICAL_PARTS', 5,  true, now(), now()),
  ('oil-and-fluids',  'Oil & Fluids',     'oil-and-fluids',  '#00ACC1', 'oil',        'OIL_AND_FLUIDS',   6,  true, now(), now()),
  ('belts-and-hoses', 'Belts & Hoses',    'belts-and-hoses', '#795548', 'belts',      'BELTS_AND_HOSES',  7,  true, now(), now()),
  ('wipers',          'Wipers',           'wipers',          '#607D8B', 'wipers',     'WIPERS',           8,  true, now(), now()),
  ('lighting',        'Lighting',         'lighting',        '#F9AB00', 'lighting',   'LIGHTING',         9,  true, now(), now()),
  ('suspension',      'Suspension',       'suspension',      '#009688', 'suspension', 'SUSPENSION',       10, true, now(), now()),
  ('exterior',        'Exterior',         'exterior',        '#5F6368', 'exterior',   'EXTERIOR',         11, true, now(), now())
ON CONFLICT ("id") DO UPDATE SET
  "name"          = EXCLUDED."name",
  "slug"          = EXCLUDED."slug",
  "color"         = EXCLUDED."color",
  "icon_key"      = EXCLUDED."icon_key",
  "main_category" = EXCLUDED."main_category",
  "sort_order"    = EXCLUDED."sort_order",
  "is_active"     = true,
  "updated_at"    = now();

-- ── c. Fallback row (must exist; main_category stays NULL) ─────────────────────
INSERT INTO "part_categories" ("id", "name", "slug", "main_category", "sort_order", "is_active", "created_at", "updated_at")
VALUES ('cat_uncategorized', 'Uncategorized', 'uncategorized', NULL, 999, true, now(), now())
ON CONFLICT ("id") DO UPDATE SET
  "is_active"  = true,
  "updated_at" = now();

-- ── d. BACKFILL catalog_parts.category_id (THE critical step) ──────────────────
-- Repoint every part at the category mirroring its classified main_category.
-- The join maps enum → canonical row via main_category; only the 12 canonical
-- rows carry a non-null main_category, so the target is unambiguous.
UPDATE "catalog_parts" cp
SET "category_id" = pc."id"
FROM "part_categories" pc
WHERE pc."main_category" = cp."main_category"
  AND cp."main_category" IS NOT NULL
  AND cp."category_id" IS DISTINCT FROM pc."id";

-- Parts with no bot classification land in the fallback bucket.
UPDATE "catalog_parts"
SET "category_id" = 'cat_uncategorized'
WHERE "main_category" IS NULL
  AND "category_id" IS DISTINCT FROM 'cat_uncategorized';

-- ── e. Deactivate old orphan seed rows ─────────────────────────────────────────
-- Legacy 8-slug seed ('maintenance','electrical','climate','tuning',…) and any
-- other non-canonical row: parts were just repointed away, so hide them from the
-- buyer grid. NOT deleted (category_id is a Restrict FK; be safe regardless).
UPDATE "part_categories"
SET "is_active" = false, "updated_at" = now()
WHERE "id" NOT IN (
  'brakes','batteries','filters','ignition','engine','electrical-parts',
  'oil-and-fluids','belts-and-hoses','wipers','lighting','suspension','exterior',
  'cat_uncategorized'
)
AND "is_active" = true;
