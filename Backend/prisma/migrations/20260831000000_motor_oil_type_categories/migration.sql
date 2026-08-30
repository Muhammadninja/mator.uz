-- The motor-oil base COMPOSITIONS become categories.
--
-- The seller used to answer a separate "тип масла" question whose answer landed
-- in products.oil_type. That made the composition a second source of truth
-- alongside the category. It is now the CATEGORY itself: picking "Синтетическое
-- моторное масло" both files the listing and derives its oil_type
-- (OIL_TYPE_BY_CATEGORY in catalog/categories/category-map.ts).
--
-- Resulting tree — the four options BOTH wizard paths open:
--
--   motor-oil (Моторные масла)
--   ├── synthetic-motor-oil        → oil_type = SYNTHETIC
--   ├── semi-synthetic-motor-oil   → oil_type = SEMI_SYNTHETIC
--   ├── mineral-motor-oil          → oil_type = MINERAL
--   └── transmission-oil           → oil_type = NULL (denotes no composition)
--
-- oil_viscosity stays an ATTRIBUTE and is NOT a category (see the previous
-- migration, 20260830020000_retire_viscosity_categories).
--
-- Purely ADDITIVE: three rows are created and existing listings are re-filed
-- onto them from the oil_type they already carry. Nothing is deleted, and no
-- oil_type is invented — a motor oil whose type was never answered stays on
-- `motor-oil` and remains a reported fiscal gap rather than being guessed onto
-- one of the three codes.
--
-- Idempotent and safe to re-run.

-- ── 1. The three composition categories (level 1, under motor-oil) ───────────
INSERT INTO "part_categories"
  ("id", "name", "name_ru", "name_uz", "name_en", "slug", "parent_id",
   "main_category", "level", "sort_order", "is_active", "created_at", "updated_at")
VALUES
  ('synthetic-motor-oil', 'Синтетическое моторное масло',
   'Синтетическое моторное масло', 'Sintetik motor moyi', 'Synthetic Motor Oil',
   'synthetic-motor-oil', 'motor-oil', NULL, 1, 0, true, now(), now()),
  ('semi-synthetic-motor-oil', 'Полусинтетическое моторное масло',
   'Полусинтетическое моторное масло', 'Yarim sintetik motor moyi',
   'Semi-Synthetic Motor Oil',
   'semi-synthetic-motor-oil', 'motor-oil', NULL, 1, 1, true, now(), now()),
  ('mineral-motor-oil', 'Минеральное моторное масло',
   'Минеральное моторное масло', 'Mineral motor moyi', 'Mineral Motor Oil',
   'mineral-motor-oil', 'motor-oil', NULL, 1, 2, true, now(), now())
ON CONFLICT ("id") DO UPDATE SET
  "parent_id"  = 'motor-oil',
  "level"      = 1,
  "is_active"  = true,
  "updated_at" = now();

-- Transmission oil keeps its place beside them (it is seeded already; this only
-- fixes its ordering so the four read in the intended order).
UPDATE "part_categories" SET "sort_order" = 3, "updated_at" = now()
  WHERE "id" = 'transmission-oil';

-- ── 2. Re-file existing oil listings onto the composition they already state ──
-- Only rows sitting on the `motor-oil` PARENT are moved: a listing already on a
-- leaf has been placed and must not be dragged elsewhere. The oil_type is read,
-- never written — this maps an existing answer onto its new home.
UPDATE "products" SET "category_id" = 'synthetic-motor-oil'
  WHERE "category_id" = 'motor-oil' AND "oil_type" = 'SYNTHETIC';
UPDATE "products" SET "category_id" = 'semi-synthetic-motor-oil'
  WHERE "category_id" = 'motor-oil' AND "oil_type" = 'SEMI_SYNTHETIC';
UPDATE "products" SET "category_id" = 'mineral-motor-oil'
  WHERE "category_id" = 'motor-oil' AND "oil_type" = 'MINERAL';

UPDATE "product_drafts" SET "category_id" = 'synthetic-motor-oil'
  WHERE "category_id" = 'motor-oil' AND "oil_type" = 'SYNTHETIC';
UPDATE "product_drafts" SET "category_id" = 'semi-synthetic-motor-oil'
  WHERE "category_id" = 'motor-oil' AND "oil_type" = 'SEMI_SYNTHETIC';
UPDATE "product_drafts" SET "category_id" = 'mineral-motor-oil'
  WHERE "category_id" = 'motor-oil' AND "oil_type" = 'MINERAL';

UPDATE "catalog_parts" SET "category_id" = 'synthetic-motor-oil'
  WHERE "category_id" = 'motor-oil' AND "oil_type" = 'SYNTHETIC';
UPDATE "catalog_parts" SET "category_id" = 'semi-synthetic-motor-oil'
  WHERE "category_id" = 'motor-oil' AND "oil_type" = 'SEMI_SYNTHETIC';
UPDATE "catalog_parts" SET "category_id" = 'mineral-motor-oil'
  WHERE "category_id" = 'motor-oil' AND "oil_type" = 'MINERAL';
