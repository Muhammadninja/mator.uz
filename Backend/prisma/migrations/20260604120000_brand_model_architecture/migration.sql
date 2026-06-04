-- CreateTable: brands
CREATE TABLE "brands" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable: car_models
CREATE TABLE "car_models" (
    "id" SERIAL NOT NULL,
    "brand_id" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    CONSTRAINT "car_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable: part_models
CREATE TABLE "part_models" (
    "part_id" INTEGER NOT NULL,
    "model_id" INTEGER NOT NULL,
    CONSTRAINT "part_models_pkey" PRIMARY KEY ("part_id","model_id")
);

-- Add updated_at to products (was missing in original schema)
ALTER TABLE "products" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Drop car_model from products
ALTER TABLE "products" DROP COLUMN IF EXISTS "car_model";

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");
CREATE UNIQUE INDEX "car_models_brand_id_name_key" ON "car_models"("brand_id", "name");

-- AddForeignKey: car_models → brands
ALTER TABLE "car_models" ADD CONSTRAINT "car_models_brand_id_fkey"
    FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: part_models → products
ALTER TABLE "part_models" ADD CONSTRAINT "part_models_part_id_fkey"
    FOREIGN KEY ("part_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: part_models → car_models
ALTER TABLE "part_models" ADD CONSTRAINT "part_models_model_id_fkey"
    FOREIGN KEY ("model_id") REFERENCES "car_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
