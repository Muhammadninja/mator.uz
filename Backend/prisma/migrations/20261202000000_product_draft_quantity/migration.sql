-- The Telegram wizard now asks how many items the seller has (QUANTITY, the last
-- question of every flow). Until now every bot listing was written with the
-- Stock default quantity of 1. The answer is kept on the draft so a resumed or
-- edited draft loses nothing, and is written to stocks.quantity on commit.
--
-- Nullable with no default: null means "not answered yet", and the draft is not
-- complete (no preview) until it is answered.
--
-- DEPLOY ORDER: apply this migration BEFORE the code that reads the column.
ALTER TABLE "product_drafts" ADD COLUMN IF NOT EXISTS "quantity" INTEGER;

-- Drafts whose questionnaire was already finished under the old flow (price
-- answered) would otherwise never count as complete again and get stuck. They
-- keep what the old flow gave them: one item. A photo-update draft has no price
-- and is not touched. Finished drafts (published, cancelled, expired) are left
-- alone.
UPDATE "product_drafts"
SET "quantity" = 1
WHERE "quantity" IS NULL
  AND "price_uzs" IS NOT NULL
  AND "status" IN ('CREATING', 'READY_FOR_PREVIEW', 'COMMITTING');
