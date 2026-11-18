-- Start years for the Chevrolet models 20261124000000 held back (owner decision
-- 2026-11-17: fill them). Same rule as there: a year is accepted when the model
-- was built anywhere in it; ends stay open because all four are still built or
-- their end is unverified. Sources: Backend/docs/vehicle-images/catalog-year-sources.md.
-- Only fill a start that is absent; preserve any operator data and year_to.

-- Daewoo launched the Damas and the Labo together at Changwon in August 1991;
-- UzAuto still builds both.
UPDATE "vehicle_models"
SET "year_from" = 1991, "updated_at" = NOW()
WHERE "id" IN ('damas', 'labo')
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL;

-- The Spark name arrived with the 2005 M200 (the Matiz before it is its own
-- row, chevrolet-matiz). Uzbek production ended in 2022; the end stays open.
UPDATE "vehicle_models"
SET "year_from" = 2005, "updated_at" = NOW()
WHERE "id" = 'spark'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL;

-- Both Tracker rows hold the Trax-based Tracker (on sale as Tracker from 2013
-- in Russia and South America) and its 2019 successor. The unrelated
-- Suzuki-based Geo/Chevrolet Tracker of 1989-2008 is not in this catalog.
UPDATE "vehicle_models"
SET "year_from" = 2013, "updated_at" = NOW()
WHERE "id" IN ('tracker', 'tracker-2')
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL;
