-- Production years for the Uzbekistan lineup models (migration 20261125000000).
-- Owner rule: a year is accepted when the model was built anywhere in it; `year`
-- is the build year. An empty end = still produced (accepted up to next year).
-- Only rows whose two bounds are both empty change. Sources:
-- Backend/docs/vehicle-images/catalog-year-sources.md. Not set: nameplates older
-- than the picker's window (Camry, RAV4, Land Cruiser Prado, Elantra, Sorento,
-- Carens, Carnival, Bongo, Patrol) and rows without a reliable source (K3, Tiggo 2 Pro).

-- K9 (RJ) from 2012; still produced.
UPDATE "vehicle_models"
SET "year_from" = 2012, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'kia-k9'
  AND "make_id" = 'kia'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- K8 (GL3) from 2021.
UPDATE "vehicle_models"
SET "year_from" = 2021, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'kia-k8'
  AND "make_id" = 'kia'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Seltos launched August 2019.
UPDATE "vehicle_models"
SET "year_from" = 2019, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'kia-seltos'
  AND "make_id" = 'kia'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Sonet (QY) from 2020.
UPDATE "vehicle_models"
SET "year_from" = 2020, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'kia-sonet'
  AND "make_id" = 'kia'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Palisade built since late 2018 (Korean launch 2018-12-11).
UPDATE "vehicle_models"
SET "year_from" = 2018, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'hyundai-palisade'
  AND "make_id" = 'hyundai'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Mufasa premiered at Auto Shanghai 2023, on sale from June 2023.
UPDATE "vehicle_models"
SET "year_from" = 2023, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'hyundai-mufasa'
  AND "make_id" = 'hyundai'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Staria world premiere 2021-04-13.
UPDATE "vehicle_models"
SET "year_from" = 2021, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'hyundai-staria'
  AND "make_id" = 'hyundai'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- H6 from 2011.
UPDATE "vehicle_models"
SET "year_from" = 2011, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'haval-h6'
  AND "make_id" = 'haval'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- H7 from 2015; a new H7 continues the nameplate.
UPDATE "vehicle_models"
SET "year_from" = 2015, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'haval-h7'
  AND "make_id" = 'haval'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- H9 from 2014.
UPDATE "vehicle_models"
SET "year_from" = 2014, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'haval-h9'
  AND "make_id" = 'haval'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Jolion launched in China in 2020.
UPDATE "vehicle_models"
SET "year_from" = 2020, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'haval-jolion'
  AND "make_id" = 'haval'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- M6 from 2017.
UPDATE "vehicle_models"
SET "year_from" = 2017, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'haval-m6'
  AND "make_id" = 'haval'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Land Cruiser 300 premiered 2021-06-09, deliveries from 2021.
UPDATE "vehicle_models"
SET "year_from" = 2021, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'toyota-land-cruiser-300'
  AND "make_id" = 'toyota'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Tiggo 4 Pro launched 2021.
UPDATE "vehicle_models"
SET "year_from" = 2021, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'chery-tiggo-4-pro'
  AND "make_id" = 'chery'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Arrizo 6 Pro launched in Brazil in October 2021.
UPDATE "vehicle_models"
SET "year_from" = 2021, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'chery-arrizo-6-pro'
  AND "make_id" = 'chery'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Arrizo 8 introduced in 2022.
UPDATE "vehicle_models"
SET "year_from" = 2022, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'chery-arrizo-8'
  AND "make_id" = 'chery'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Fang Cheng Bao Tai 7 (BYD Ti 7) mass production from 2025-08-11.
UPDATE "vehicle_models"
SET "year_from" = 2025, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'byd-ti-7'
  AND "make_id" = 'byd'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Teramont X premiered at Auto Shanghai 2019, on sale from May 2019.
UPDATE "vehicle_models"
SET "year_from" = 2019, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'teramont-x'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Vesta production started 2015-09-25.
UPDATE "vehicle_models"
SET "year_from" = 2015, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'lada-vesta'
  AND "make_id" = 'lada'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Largus production started 2012-04-04 (revived 2024).
UPDATE "vehicle_models"
SET "year_from" = 2012, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'lada-largus'
  AND "make_id" = 'lada'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- XRay built December 2015 to 2022 (ended under sanctions).
UPDATE "vehicle_models"
SET "year_from" = 2015, "year_to" = 2022, "updated_at" = NOW()
WHERE "id" = 'lada-xray'
  AND "make_id" = 'lada'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Tivoli launched 2015.
UPDATE "vehicle_models"
SET "year_from" = 2015, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'tivoli'
  AND "make_id" = 'ssangyong'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Tivoli XLV / Tivoli Air launched 2016.
UPDATE "vehicle_models"
SET "year_from" = 2016, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'xlv'
  AND "make_id" = 'ssangyong'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;
