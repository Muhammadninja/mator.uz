-- CreateEnum
CREATE TYPE "SourcingRequestStatus" AS ENUM ('PROCESSING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "SourcingStaffNotifyStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SOURCING_STATUS';

-- AlterEnum
ALTER TYPE "SourcingTicketStatus" ADD VALUE 'NO_OFFER';

-- AlterTable
ALTER TABLE "sourcing_offers" ADD COLUMN     "customer_notify_pending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "expires_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "sourcing_tickets" ADD COLUMN     "customer_notice" VARCHAR(32),
ADD COLUMN     "escalated_at" TIMESTAMPTZ(3),
ADD COLUMN     "part_key" TEXT,
ADD COLUMN     "part_name" TEXT,
ADD COLUMN     "request_id" UUID,
ADD COLUMN     "staff_notified_at" TIMESTAMPTZ(3),
ADD COLUMN     "staff_notify_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "staff_notify_error" TEXT,
ADD COLUMN     "staff_notify_next_at" TIMESTAMPTZ(3),
ADD COLUMN     "staff_notify_status" "SourcingStaffNotifyStatus",
ADD COLUMN     "vehicle_id" VARCHAR(64),
ADD COLUMN     "vehicle_key" VARCHAR(200);

-- CreateTable
CREATE TABLE "sourcing_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "status" "SourcingRequestStatus" NOT NULL DEFAULT 'PROCESSING',
    "lease_token" VARCHAR(64),
    "lease_expires_at" TIMESTAMPTZ(3),
    "vehicle_id" VARCHAR(64),
    "response" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sourcing_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sourcing_requests_user_id_idempotency_key_key" ON "sourcing_requests"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "sourcing_offers_customer_notify_pending_idx" ON "sourcing_offers"("customer_notify_pending");

-- CreateIndex
CREATE INDEX "sourcing_offers_status_expires_at_idx" ON "sourcing_offers"("status", "expires_at");

-- CreateIndex
CREATE INDEX "sourcing_tickets_request_id_idx" ON "sourcing_tickets"("request_id");

-- CreateIndex
CREATE INDEX "sourcing_tickets_user_id_part_key_vehicle_key_idx" ON "sourcing_tickets"("user_id", "part_key", "vehicle_key");

-- CreateIndex
CREATE INDEX "sourcing_tickets_staff_notify_status_staff_notify_next_at_idx" ON "sourcing_tickets"("staff_notify_status", "staff_notify_next_at");

-- CreateIndex
CREATE INDEX "sourcing_tickets_customer_notice_idx" ON "sourcing_tickets"("customer_notice");

-- AddForeignKey
ALTER TABLE "sourcing_requests" ADD CONSTRAINT "sourcing_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sourcing_tickets" ADD CONSTRAINT "sourcing_tickets_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "sourcing_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

