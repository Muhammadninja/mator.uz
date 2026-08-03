-- CreateEnum
CREATE TYPE "SourcingTicketStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'OFFERED', 'CLOSED');

-- CreateTable
CREATE TABLE "sourcing_tickets" (
    "id" UUID NOT NULL,
    "user_id" TEXT,
    "raw_message" TEXT NOT NULL,
    "extracted_data" JSONB NOT NULL,
    "status" "SourcingTicketStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sourcing_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sourcing_tickets_status_idx" ON "sourcing_tickets"("status");

-- CreateIndex
CREATE INDEX "sourcing_tickets_user_id_idx" ON "sourcing_tickets"("user_id");
