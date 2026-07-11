-- CreateEnum
CREATE TYPE "PartMainCategory" AS ENUM ('BRAKES', 'BATTERIES', 'FILTERS', 'IGNITION', 'ENGINE', 'ELECTRICAL_PARTS', 'OIL_AND_FLUIDS', 'BELTS_AND_HOSES', 'WIPERS', 'LIGHTING', 'SUSPENSION', 'EXTERIOR');

-- CreateEnum
CREATE TYPE "PartVehicleCategory" AS ENUM ('BRAKE_SYSTEM', 'MAINTENANCE_AND_FLUIDS', 'SUSPENSION_AND_STEERING', 'ELECTRICAL_AND_LIGHTING', 'ENGINE', 'TRANSMISSION', 'HEATING_AND_COOLING', 'TUNING_AND_ACCESSORIES');

-- CreateEnum
CREATE TYPE "PartOriginRegion" AS ENUM ('CHINA', 'EUROPE', 'RUSSIA', 'KOREA', 'USA');

-- AlterTable
ALTER TABLE "catalog_parts" ADD COLUMN     "is_gm" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_oem" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_universal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "main_category" "PartMainCategory",
ADD COLUMN     "origin_region" "PartOriginRegion",
ADD COLUMN     "part_brand_name" VARCHAR(120),
ADD COLUMN     "vehicle_category" "PartVehicleCategory";

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "is_gm" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_oem" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "main_category" "PartMainCategory",
ADD COLUMN     "origin_region" "PartOriginRegion",
ADD COLUMN     "part_brand" VARCHAR(120),
ADD COLUMN     "vehicle_category" "PartVehicleCategory";

-- CreateTable
CREATE TABLE "catalog_part_fits" (
    "part_id" VARCHAR(64) NOT NULL,
    "make_slug" VARCHAR(80) NOT NULL,
    "model_slug" VARCHAR(96) NOT NULL,
    "make_name" VARCHAR(120) NOT NULL,
    "model_name" VARCHAR(120) NOT NULL,

    CONSTRAINT "catalog_part_fits_pkey" PRIMARY KEY ("part_id","model_slug")
);

-- CreateIndex
CREATE INDEX "catalog_part_fits_make_slug_idx" ON "catalog_part_fits"("make_slug");

-- CreateIndex
CREATE INDEX "catalog_part_fits_model_slug_idx" ON "catalog_part_fits"("model_slug");

-- CreateIndex
CREATE INDEX "catalog_parts_main_category_idx" ON "catalog_parts"("main_category");

-- CreateIndex
CREATE INDEX "catalog_parts_vehicle_category_idx" ON "catalog_parts"("vehicle_category");

-- CreateIndex
CREATE INDEX "catalog_parts_origin_region_idx" ON "catalog_parts"("origin_region");

-- CreateIndex
CREATE INDEX "catalog_parts_is_gm_idx" ON "catalog_parts"("is_gm");

-- CreateIndex
CREATE INDEX "catalog_parts_is_oem_idx" ON "catalog_parts"("is_oem");

-- CreateIndex
CREATE INDEX "products_main_category_idx" ON "products"("main_category");

-- CreateIndex
CREATE INDEX "products_vehicle_category_idx" ON "products"("vehicle_category");

-- AddForeignKey
ALTER TABLE "catalog_part_fits" ADD CONSTRAINT "catalog_part_fits_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "catalog_parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

