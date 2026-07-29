-- Extend the buyer-facing vehicle catalog (vehicle_makes / vehicle_models) with
-- the admin-editable metadata + audit timestamps the operator brands/models
-- console reads and writes. These are the same rows the mobile app reads via
-- GET /v1/reference/makes and /models.

ALTER TABLE "vehicle_makes" ADD COLUMN "country" VARCHAR(80), ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "vehicle_models" ADD COLUMN "year_from" INTEGER, ADD COLUMN "year_to" INTEGER, ADD COLUMN "body_type" VARCHAR(60), ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
