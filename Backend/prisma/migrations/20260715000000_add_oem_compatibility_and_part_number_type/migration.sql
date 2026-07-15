-- CreateEnum
CREATE TYPE "PartNumberType" AS ENUM ('GM', 'OEM', 'UNKNOWN');

-- AlterTable: supply-side Product gains the OEM value + labeled type.
ALTER TABLE "products"
  ADD COLUMN "oem_number" VARCHAR(50),
  ADD COLUMN "part_number_type" "PartNumberType" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable: buyer catalog gains GM numbers + labeled type (OEM already present).
ALTER TABLE "catalog_parts"
  ADD COLUMN "gm_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "part_number_type" "PartNumberType" NOT NULL DEFAULT 'UNKNOWN';

-- CreateTable: verified internal OEM → vehicle compatibility (manually curated,
-- one row per (oemNumber, make, model); oemNumber is intentionally NOT unique).
CREATE TABLE "oem_compatibility" (
    "id" SERIAL NOT NULL,
    "oem_number" VARCHAR(50) NOT NULL,
    "make" VARCHAR(120) NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oem_compatibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oem_compatibility_oem_number_make_model_key" ON "oem_compatibility"("oem_number", "make", "model");

-- CreateIndex
CREATE INDEX "oem_compatibility_oem_number_idx" ON "oem_compatibility"("oem_number");
