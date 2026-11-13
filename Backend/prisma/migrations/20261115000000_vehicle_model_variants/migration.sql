-- Generation-specific catalog rows for a generic model, and the owner's pick of one
-- for a Garage vehicle. Additive only: two nullable columns, their indexes and FKs,
-- and catalog data for the three Chevrolet Nexia generation rows.
--
-- Visual identity only. `vehicles.model_id`, trims and every fitment table are
-- untouched, so compatibility answers are unchanged.

-- AlterTable
ALTER TABLE "vehicle_models" ADD COLUMN "variant_of_model_id" VARCHAR(64);

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN "variant_model_id" VARCHAR(64);

-- CreateIndex
CREATE INDEX "vehicle_models_variant_of_model_id_idx" ON "vehicle_models"("variant_of_model_id");

-- CreateIndex
CREATE INDEX "vehicles_variant_model_id_idx" ON "vehicles"("variant_model_id");

-- AddForeignKey
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_variant_of_model_id_fkey" FOREIGN KEY ("variant_of_model_id") REFERENCES "vehicle_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_variant_model_id_fkey" FOREIGN KEY ("variant_model_id") REFERENCES "vehicle_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Chevrolet Nexia, built at Asaka (UzDaewoo → GM Uzbekistan → UzAuto Motors).
-- Build years, the year the Garage asks for ("год выпуска"):
--   N100 (`nexia-1`)  1996–2008  built at Asaka for 20 years up to 2016 (anhor.uz
--                                2016-08-12); replaced by the N150 in mid-2008
--                                (kolesa.ru test drive 2008-07-11; Za Rulem).
--   N150 (`nexia-2`)  2008–2016  last car built 2016-08-01 (gazeta.uz 2016-08-08,
--                                anhor.uz 2016-08-12).
--   R3   (`nexia-3`)  2016–2022  on sale in Uzbekistan from 2016-08-08 (gazeta.uz);
--                                sales ended October 2022 (autostrada.uz 2023-03-29).
-- 2008 and 2016 each belong to two generations, so those years ask the owner.
-- Each row changes only when it exists and still belongs to Chevrolet; the link is
-- set only when the generic `nexia` row exists.
UPDATE "vehicle_models" SET "year_from" = 1996, "year_to" = 2008,
  "variant_of_model_id" = (SELECT "id" FROM "vehicle_models" WHERE "id" = 'nexia' AND "make_id" = 'chevrolet')
  WHERE "id" = 'nexia-1' AND "make_id" = 'chevrolet';
UPDATE "vehicle_models" SET "year_from" = 2008, "year_to" = 2016,
  "variant_of_model_id" = (SELECT "id" FROM "vehicle_models" WHERE "id" = 'nexia' AND "make_id" = 'chevrolet')
  WHERE "id" = 'nexia-2' AND "make_id" = 'chevrolet';
UPDATE "vehicle_models" SET "year_from" = 2016, "year_to" = 2022,
  "variant_of_model_id" = (SELECT "id" FROM "vehicle_models" WHERE "id" = 'nexia' AND "make_id" = 'chevrolet')
  WHERE "id" = 'nexia-3' AND "make_id" = 'chevrolet';
