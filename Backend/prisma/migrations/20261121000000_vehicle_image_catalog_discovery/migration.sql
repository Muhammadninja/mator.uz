CREATE TYPE "VehicleImageCatalogDiscoveryStatus" AS ENUM (
  'REVIEW_REQUIRED', 'SCHEDULED', 'EXISTING', 'APPROVED', 'FAILED'
);
CREATE TYPE "VehicleImageCatalogDiscoveryRunStatus" AS ENUM (
  'RUNNING', 'COMPLETED', 'FAILED'
);
CREATE TYPE "VehicleImageCatalogDiscoveryTrigger" AS ENUM (
  'SCHEDULED', 'BACKFILL', 'ADMIN'
);
ALTER TYPE "AdminAuditAction" ADD VALUE 'VEHICLE_IMAGE_CATALOG_DISCOVERY_RUN';

CREATE TABLE "vehicle_image_catalog_discovery" (
  "source_key" VARCHAR(200) NOT NULL,
  "make_id" VARCHAR(64) NOT NULL,
  "model_id" VARCHAR(64) NOT NULL,
  "generation_id" VARCHAR(64),
  "source_fingerprint" CHAR(64) NOT NULL,
  "status" "VehicleImageCatalogDiscoveryStatus" NOT NULL,
  "reason" VARCHAR(80),
  "identity_key" CHAR(64),
  "last_run_id" VARCHAR(64),
  "last_error" VARCHAR(80),
  "last_scanned_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_image_catalog_discovery_pkey" PRIMARY KEY ("source_key")
);
CREATE INDEX "vehicle_image_catalog_discovery_status_last_scanned_at_idx"
  ON "vehicle_image_catalog_discovery"("status", "last_scanned_at");
CREATE INDEX "vehicle_image_catalog_discovery_identity_key_idx"
  ON "vehicle_image_catalog_discovery"("identity_key");

CREATE TABLE "vehicle_image_catalog_discovery_runs" (
  "id" VARCHAR(64) NOT NULL,
  "trigger" "VehicleImageCatalogDiscoveryTrigger" NOT NULL,
  "status" "VehicleImageCatalogDiscoveryRunStatus" NOT NULL DEFAULT 'RUNNING',
  "scanned" INTEGER NOT NULL DEFAULT 0,
  "scheduled" INTEGER NOT NULL DEFAULT 0,
  "existing" INTEGER NOT NULL DEFAULT 0,
  "approved" INTEGER NOT NULL DEFAULT 0,
  "review_required" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  "last_error" VARCHAR(80),
  CONSTRAINT "vehicle_image_catalog_discovery_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vehicle_image_catalog_discovery_runs_started_at_idx"
  ON "vehicle_image_catalog_discovery_runs"("started_at");
CREATE INDEX "vehicle_image_catalog_discovery_runs_status_started_at_idx"
  ON "vehicle_image_catalog_discovery_runs"("status", "started_at");
