-- AlterEnum: new sourcing-ticket lifecycle states
ALTER TYPE "SourcingTicketStatus" ADD VALUE 'ACCEPTED';
ALTER TYPE "SourcingTicketStatus" ADD VALUE 'CANCELLED';

-- AlterEnum: new notification type for delivered offers
ALTER TYPE "NotificationType" ADD VALUE 'SOURCING_OFFER';

-- CreateEnum
CREATE TYPE "SourcingOfferCondition" AS ENUM ('NEW', 'USED', 'OEM', 'AFTERMARKET', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SourcingOfferAvailability" AS ENUM ('IN_STOCK', 'ON_ORDER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SourcingOfferStatus" AS ENUM ('SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateTable
CREATE TABLE "sourcing_offers" (
    "id" VARCHAR(64) NOT NULL,
    "ticket_id" UUID NOT NULL,
    "price" INTEGER NOT NULL,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'UZS',
    "condition" "SourcingOfferCondition" NOT NULL DEFAULT 'UNKNOWN',
    "availability" "SourcingOfferAvailability" NOT NULL DEFAULT 'UNKNOWN',
    "eta_days" INTEGER,
    "note" TEXT,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seller_tg_id" TEXT NOT NULL,
    "seller_name" TEXT,
    "seller_username" TEXT,
    "status" "SourcingOfferStatus" NOT NULL DEFAULT 'SENT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sourcing_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sourcing_offers_ticket_id_idx" ON "sourcing_offers"("ticket_id");

-- CreateIndex
CREATE INDEX "sourcing_offers_status_idx" ON "sourcing_offers"("status");

-- AddForeignKey
ALTER TABLE "sourcing_offers" ADD CONSTRAINT "sourcing_offers_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "sourcing_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
