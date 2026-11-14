-- Vehicle image lifecycle: actionable pipeline errors, idempotent re-resolution
-- of saved Garage vehicles, a rollback log for that re-resolution, and audit
-- actions for administrator image review. Additive only: no existing column,
-- row or value changes. Apply before deploying the code that writes them.

ALTER TABLE "vehicle_image_identities"
  ADD COLUMN IF NOT EXISTS "last_error" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "last_error_at" TIMESTAMPTZ(3);

ALTER TABLE "vehicles"
  ADD COLUMN IF NOT EXISTS "identity_resolved_with" VARCHAR(80);

CREATE TABLE IF NOT EXISTS "vehicle_image_reconcile_log" (
  "id" BIGSERIAL NOT NULL,
  "run_id" VARCHAR(40) NOT NULL,
  "vehicle_id" VARCHAR(64) NOT NULL,
  "previous" JSONB NOT NULL,
  "next" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_image_reconcile_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "vehicle_image_reconcile_log_run_id_idx" ON "vehicle_image_reconcile_log"("run_id");
CREATE INDEX IF NOT EXISTS "vehicle_image_reconcile_log_vehicle_id_idx" ON "vehicle_image_reconcile_log"("vehicle_id");

-- New enum values are not used in this transaction (PostgreSQL 12+).
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VEHICLE_IMAGE_APPROVED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VEHICLE_IMAGE_REJECTED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VEHICLE_IMAGE_UPLOADED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VEHICLE_IMAGE_RETRIED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VEHICLE_IMAGE_RECONCILED';
ALTER TYPE "AdminAuditEntity" ADD VALUE IF NOT EXISTS 'VEHICLE_IMAGE';
