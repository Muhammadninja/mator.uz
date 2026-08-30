-- Add the ANTIFREEZE product kind and its one attribute column.
--
-- Purely ADDITIVE, exactly like 20260728010000_add_product_kinds_and_motor_oil:
-- one new enum VALUE plus a nullable column on the three tables that carry
-- kind-specific attributes. Nothing is dropped, renamed, retyped or backfilled,
-- so every existing product, draft and catalog part keeps its current meaning.
--
-- WHY GRAMS. Antifreeze is sold BY WEIGHT ("2.5 кг"), never by the piece, so the
-- listing carries the packaged NET WEIGHT. It is stored as an INTEGER number of
-- GRAMS for the same reason oil volume is stored in millilitres: fractional
-- kilograms must sort, filter and compare exactly, and the "2.5 кг" label is
-- derived at render time rather than stored as text. 2.5 кг ⇒ 2500.
--
-- DEPLOY ORDER: this migration must be applied BEFORE the code that writes
-- 'ANTIFREEZE' — PostgreSQL cannot use a new enum value inside the transaction
-- that created it, and a rolling deploy would otherwise have old pods reading a
-- value their enum type does not know.

-- AlterEnum: additive, so no existing row changes.
ALTER TYPE "ProductKind" ADD VALUE IF NOT EXISTS 'ANTIFREEZE';

-- AlterTable: supply-side product
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "antifreeze_weight_g" INTEGER;

-- AlterTable: in-progress wizard draft (mirrors the product column so a resumed
-- or edited draft loses nothing).
ALTER TABLE "product_drafts"
  ADD COLUMN IF NOT EXISTS "antifreeze_weight_g" INTEGER;

-- AlterTable: buyer-facing read model (projected verbatim from products).
ALTER TABLE "catalog_parts"
  ADD COLUMN IF NOT EXISTS "antifreeze_weight_g" INTEGER;
