-- Source-backed Uzbekistan production ranges for two unambiguous single-model
-- records. These are model-level ranges; no trim/generation mapping is added.
-- Matiz: UzAuto says production began August 2001 and assembly ended July 2018:
-- https://uzautomotors.com/public/articles/gm_uzbekistan_snimaet_s_proizvodstvo_chevrolet_matiz
-- Orlando: Chevrolet Uzbekistan history says production began March 2014:
-- https://chevrolet.uz/index.php/page/istoriya-chevrolet
-- UzAuto says assembly ended in Q1 2018:
-- https://uzautomotors.com/articles/gm_uzbekistan_snimaet_s_proizvodstvo_chevrolet_orlando
-- Only fill rows whose existing bounds are both absent; preserve any operator data.
UPDATE "vehicle_models"
SET "year_from" = 2001, "year_to" = 2018, "updated_at" = NOW()
WHERE "id" = 'chevrolet-matiz'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

UPDATE "vehicle_models"
SET "year_from" = 2014, "year_to" = 2018, "updated_at" = NOW()
WHERE "id" = 'orlando'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;
