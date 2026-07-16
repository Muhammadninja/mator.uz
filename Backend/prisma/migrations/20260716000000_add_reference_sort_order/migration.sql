-- Phase 2C: explicit ordering for reference tables so the API can reproduce the
-- frontend catalog order (VehicleMake already had sort_order). Additive,
-- backward-compatible: NOT NULL DEFAULT 0.

-- AlterTable
ALTER TABLE "vehicle_engines" ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "vehicle_models" ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "vehicle_trims" ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0;
