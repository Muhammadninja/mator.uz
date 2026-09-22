-- Driver's Village photo updates from Telegram (album + caption = code_1c).
--
-- Purely ADDITIVE: one nullable column and one index on product_drafts. Every
-- existing draft keeps target_stock_id NULL, which is exactly "an ordinary
-- listing draft" — its behaviour does not change.
--
-- A draft with target_stock_id set is a PHOTO-UPDATE draft: the same image
-- pipeline and preview as a new listing, but on confirm it replaces the gallery
-- of that existing stock's product and creates nothing. No FK, like every other
-- draft column: a draft is ephemeral, and the confirm path re-validates the
-- stock's Driver's Village identity (seller + source system + code_1c) before it
-- writes.

-- AlterTable
ALTER TABLE "product_drafts" ADD COLUMN "target_stock_id" INTEGER;

-- CreateIndex
CREATE INDEX "product_drafts_target_stock_id_idx" ON "product_drafts"("target_stock_id");
