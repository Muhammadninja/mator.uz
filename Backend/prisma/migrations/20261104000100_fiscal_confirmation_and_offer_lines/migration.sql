-- What a Payme receipt line needs and the schema could not say.
--
-- Purely ADDITIVE and non-destructive: nullable columns, one index and one foreign
-- key. Nothing is dropped, renamed, retyped or backfilled, and no existing MXIK is
-- touched.
--
-- ── part_categories.fiscal_confirmed_codes ──
-- The exact codes an operator confirmed against Tasnif as true of every listing of
-- the node. Deliberately NOT backfilled: the seeded codes were supplied per
-- representative product and nobody has confirmed them, so every category starts
-- unconfirmed. Payme checkout then refuses goods until an operator confirms their
-- category. That is the intended state before Payme goes live.
--
-- ── order_items.offer_id / offer_seller_tg_id ──
-- An accepted sourcing offer is goods with no catalog part, and its order line used
-- to lose every trace of the offer, so it read as "no product lines" and was paid
-- for with no receipt at all. Plain ids with no FK, like part_id: an order must
-- outlive the ticket. Lines written before this migration stay NULL and are refused
-- at checkout rather than guessed at.
--
-- ── sourcing_offers.category_id / package_form ──
-- The classification an operator gives an offer. ON DELETE SET NULL: deleting a
-- category only returns the offer to "not classified", which checkout refuses.
ALTER TABLE "part_categories" ADD COLUMN "fiscal_confirmed_codes" VARCHAR(60);

ALTER TABLE "order_items"
  ADD COLUMN "offer_id" VARCHAR(64),
  ADD COLUMN "offer_seller_tg_id" TEXT;

ALTER TABLE "sourcing_offers"
  ADD COLUMN "category_id" VARCHAR(64),
  ADD COLUMN "package_form" "PackageForm";

CREATE INDEX "sourcing_offers_category_id_idx" ON "sourcing_offers"("category_id");

ALTER TABLE "sourcing_offers"
  ADD CONSTRAINT "sourcing_offers_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "part_categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
