-- CreateEnum
CREATE TYPE "SourcingOfferDeclineReason" AS ENUM ('TOO_EXPENSIVE', 'FOUND_CHEAPER', 'NO_LONGER_NEEDED', 'OTHER');

-- AlterTable: capture why a customer declined an offer
ALTER TABLE "sourcing_offers"
  ADD COLUMN "decline_reason" "SourcingOfferDeclineReason",
  ADD COLUMN "decline_note" TEXT;

-- AlterTable: a cart line can originate from an accepted sourcing offer
ALTER TABLE "cart_items" ADD COLUMN "offer_id" VARCHAR(64);

-- AddForeignKey: dropping an offer just nulls the link, never deletes the cart line
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "sourcing_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
