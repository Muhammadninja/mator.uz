-- Phase 3E: Garage ↔ Vehicle Image Pipeline.
--
-- Additive only. Two new tables and two NULLABLE columns on "vehicles"; no existing
-- row or column is changed, and every existing Garage vehicle keeps working (its
-- image state is simply "not requested").
--
-- Deploy order: apply this migration BEFORE deploying the code. The new code reads
-- vehicles.image_identity_key / image_review_reason on every Garage read; the old
-- code never touches the new columns or tables, so it keeps running on the migrated
-- schema. ADD COLUMN ... NULL with no default does not rewrite "vehicles".
--
-- Rollback (before any row is written): drop the two tables, the two columns and
-- the two enum types. After rows exist, keep the schema and disable the integration
-- (VEHICLE_IMAGES_ENABLED unset) instead.

-- CreateEnum
CREATE TYPE "VehicleImageStatus" AS ENUM ('PENDING', 'APPROVED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "VehicleImageOutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'DEAD');

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "image_identity_key" CHAR(64),
ADD COLUMN     "image_review_reason" VARCHAR(64);

-- CreateTable
CREATE TABLE "vehicle_image_identities" (
    "identity_key" CHAR(64) NOT NULL,
    "identity" JSONB NOT NULL,
    "display" JSONB NOT NULL,
    "status" "VehicleImageStatus" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(64),
    "pipeline_status" VARCHAR(32),
    "pipeline_request_id" VARCHAR(64),
    "image_url" VARCHAR(2048),
    "image_version" INTEGER,
    "last_synced_at" TIMESTAMPTZ(3),
    "next_sync_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicle_image_identities_pkey" PRIMARY KEY ("identity_key")
);

-- CreateTable
CREATE TABLE "vehicle_image_outbox" (
    "id" VARCHAR(64) NOT NULL,
    "identity_key" CHAR(64) NOT NULL,
    "status" "VehicleImageOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(3),

    CONSTRAINT "vehicle_image_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_image_identities_next_sync_at_idx" ON "vehicle_image_identities"("next_sync_at");

-- CreateIndex
CREATE INDEX "vehicle_image_outbox_status_available_at_idx" ON "vehicle_image_outbox"("status", "available_at");

-- CreateIndex
CREATE INDEX "vehicle_image_outbox_identity_key_idx" ON "vehicle_image_outbox"("identity_key");

-- CreateIndex
CREATE INDEX "vehicles_image_identity_key_idx" ON "vehicles"("image_identity_key");

-- CreateIndex
CREATE INDEX "vehicles_image_review_reason_idx" ON "vehicles"("image_review_reason");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_image_identity_key_fkey" FOREIGN KEY ("image_identity_key") REFERENCES "vehicle_image_identities"("identity_key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_image_outbox" ADD CONSTRAINT "vehicle_image_outbox_identity_key_fkey" FOREIGN KEY ("identity_key") REFERENCES "vehicle_image_identities"("identity_key") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one PENDING outbox row per identity, so concurrent Garage creates of the
-- same vehicle identity queue a single pipeline request. Prisma cannot express a
-- partial unique index; inserts use ON CONFLICT DO NOTHING (createMany skipDuplicates).
CREATE UNIQUE INDEX "vehicle_image_outbox_one_pending_per_identity"
    ON "vehicle_image_outbox"("identity_key") WHERE "status" = 'PENDING';
