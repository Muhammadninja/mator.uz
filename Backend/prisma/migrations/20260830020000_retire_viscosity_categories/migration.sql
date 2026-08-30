-- Retire the motor-oil VISCOSITY categories.
--
-- "Масло 5W-30" / "5W-40" / "10W-40" were PartCategory rows whose only meaning
-- was a SAE grade. A grade is an ATTRIBUTE of a listing (products.oil_viscosity),
-- not a place in the taxonomy, so the nodes are removed and the grade they
-- encoded is written onto the rows that sat on them.
--
-- `transmission-oil` is NOT touched: it is a real product type and stays a child
-- of `motor-oil`, alongside the three oil TYPES the wizard offers as attributes.
--
-- ORDERING IS THE SAFETY PROPERTY. Every reference is moved off a node BEFORE the
-- node is deleted, so a failure part-way leaves categories that are merely empty
-- — never a row pointing at a category that no longer exists. catalog_parts is
-- the binding constraint: its category_id is NOT NULL with ON DELETE RESTRICT, so
-- the delete at the end physically cannot succeed while a part still refers to it.
--
-- WHAT IS NOT INFERRED: the oil TYPE (synthetic / semi-synthetic / mineral). It
-- selects the MXIK, and a viscosity does not imply a base composition — a 5W-40
-- exists in all three. Such listings keep a NULL oil_type and are reported by
-- `npm run report:viscosity-categories` rather than given a guessed fiscal code.
--
-- Idempotent and safe to re-run: once the rows are gone every statement matches
-- nothing.

-- ── 1. Record the grade, WITHOUT overwriting an answer the seller gave ────────
UPDATE "products" SET "oil_viscosity" = '5W-30'
  WHERE "category_id" = 'motor-oil-5w30' AND "oil_viscosity" IS NULL;
UPDATE "products" SET "oil_viscosity" = '5W-40'
  WHERE "category_id" = 'motor-oil-5w40' AND "oil_viscosity" IS NULL;
UPDATE "products" SET "oil_viscosity" = '10W-40'
  WHERE "category_id" = 'motor-oil-10w40' AND "oil_viscosity" IS NULL;

UPDATE "product_drafts" SET "oil_viscosity" = '5W-30'
  WHERE "category_id" = 'motor-oil-5w30' AND "oil_viscosity" IS NULL;
UPDATE "product_drafts" SET "oil_viscosity" = '5W-40'
  WHERE "category_id" = 'motor-oil-5w40' AND "oil_viscosity" IS NULL;
UPDATE "product_drafts" SET "oil_viscosity" = '10W-40'
  WHERE "category_id" = 'motor-oil-10w40' AND "oil_viscosity" IS NULL;

-- ── 2. Re-point every reference onto the motor-oil category ──────────────────
UPDATE "catalog_parts"  SET "category_id" = 'motor-oil'
  WHERE "category_id" IN ('motor-oil-5w30','motor-oil-5w40','motor-oil-10w40');
UPDATE "products"       SET "category_id" = 'motor-oil'
  WHERE "category_id" IN ('motor-oil-5w30','motor-oil-5w40','motor-oil-10w40');
UPDATE "product_drafts" SET "category_id" = 'motor-oil'
  WHERE "category_id" IN ('motor-oil-5w30','motor-oil-5w40','motor-oil-10w40');

-- The root side of the pair, so no row keeps a dangling lineage.
UPDATE "products"       SET "vehicle_category_id" = 'motor-oil'
  WHERE "vehicle_category_id" IN ('motor-oil-5w30','motor-oil-5w40','motor-oil-10w40');
UPDATE "product_drafts" SET "vehicle_category_id" = 'motor-oil'
  WHERE "vehicle_category_id" IN ('motor-oil-5w30','motor-oil-5w40','motor-oil-10w40');

-- Defensive: nothing is seeded under a viscosity, but a hand-created child would
-- otherwise be orphaned by the DELETE below (parent_id is ON DELETE SET NULL).
UPDATE "part_categories" SET "parent_id" = 'motor-oil', "level" = 1
  WHERE "parent_id" IN ('motor-oil-5w30','motor-oil-5w40','motor-oil-10w40');

-- ── 3. Drop the now-unreferenced nodes ───────────────────────────────────────
DELETE FROM "part_categories"
  WHERE "id" IN ('motor-oil-5w30','motor-oil-5w40','motor-oil-10w40');
