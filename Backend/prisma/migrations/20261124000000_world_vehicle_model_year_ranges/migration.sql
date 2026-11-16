-- World production years for Garage models (owner decision 2026-11-16): a
-- year is accepted when the model was built anywhere in it, since many cars in
-- Uzbekistan are imports. `year` is the build year (see vehicle-year.ts); an
-- open end means the model is still produced (accepted up to next year).
-- Sources per row: Backend/docs/vehicle-images/catalog-year-sources.md.
-- Only fill rows whose existing bounds are both absent; preserve any operator data.
-- Not set, on purpose: models without reliable evidence or with an ambiguous
-- catalog identity (spark, tracker, tracker-2, damas, labo, suburban and the
-- older VW nameplates), and rows already ranged (nexia, chevrolet-matiz, orlando).

-- Daewoo/Chevrolet Lacetti J200 from 2002; UzAuto built the last Lacetti (Gentra) at Asaka in July 2024.
UPDATE "vehicle_models"
SET "year_from" = 2002, "year_to" = 2024, "updated_at" = NOW()
WHERE "id" = 'lacetti'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Gentra nameplate from 2005 (Korea); Uzbek Gentra/Lacetti 2013-2024, production ended July 2024.
UPDATE "vehicle_models"
SET "year_from" = 2005, "year_to" = 2024, "updated_at" = NOW()
WHERE "id" = 'gentra'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Same car as gentra/lacetti (misspelled catalog row): union of both ranges.
UPDATE "vehicle_models"
SET "year_from" = 2002, "year_to" = 2024, "updated_at" = NOW()
WHERE "id" = 'genrta-lacetti'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- GM built the last Malibu at Fairfax on 2024-11-15; the nameplate predates the app's year picker.
UPDATE "vehicle_models"
SET "year_from" = NULL, "year_to" = 2024, "updated_at" = NOW()
WHERE "id" = 'malibu'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Epica name on V200 Magnus from 2000; V250 Korea 2006-2011, China until 2014/2015 (latest stated year kept).
UPDATE "vehicle_models"
SET "year_from" = 2000, "year_to" = 2015, "updated_at" = NOW()
WHERE "id" = 'epica'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Korea 2000-2008, Uzbekistan 2008-2009, Vietnam (Vivant) until December 2011.
UPDATE "vehicle_models"
SET "year_from" = 2000, "year_to" = 2011, "updated_at" = NOW()
WHERE "id" = 'tacuma'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Global nameplate from 2008; GM ended the last (Argentina) production at the end of 2023.
UPDATE "vehicle_models"
SET "year_from" = 2008, "year_to" = 2023, "updated_at" = NOW()
WHERE "id" = 'cruze'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- US Cobalt from 2004, Brazil/Uzbekistan Cobalt from 2011/2012; still produced.
UPDATE "vehicle_models"
SET "year_from" = 2004, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'cobalt'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Launched in Brazil in 2012; Uzbekistan production since 2022/2023; still produced.
UPDATE "vehicle_models"
SET "year_from" = 2012, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'onix'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- First generation 2006-2018, second generation from 2018/2019; still produced.
UPDATE "vehicle_models"
SET "year_from" = 2006, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'captiva'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Introduced in 2004 (model year 2005); still produced.
UPDATE "vehicle_models"
SET "year_from" = 2004, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'equinox'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Production from 2008 (model year 2009); still produced.
UPDATE "vehicle_models"
SET "year_from" = 2008, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'traverse'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Introduced for model year 1995, so built from 1994; still produced.
UPDATE "vehicle_models"
SET "year_from" = 1994, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'tahoe'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Nameplate from 2001; still produced.
UPDATE "vehicle_models"
SET "year_from" = 2001, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'trailblazer'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Chazor is the Uzbek name of the BYD Destroyer 05, launched in China in March 2022.
UPDATE "vehicle_models"
SET "year_from" = 2022, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'byd-chazor'
  AND "make_id" = 'byd'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Song Plus launched on 2020-09-16.
UPDATE "vehicle_models"
SET "year_from" = 2020, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'byd-song-plus'
  AND "make_id" = 'byd'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Han EV launched on 2020-07-12.
UPDATE "vehicle_models"
SET "year_from" = 2020, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'byd-han'
  AND "make_id" = 'byd'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Series production at Zwickau from November 2019.
UPDATE "vehicle_models"
SET "year_from" = 2019, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'id-3'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Introduced in 2020.
UPDATE "vehicle_models"
SET "year_from" = 2020, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'id-4'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Introduced in China in April 2021.
UPDATE "vehicle_models"
SET "year_from" = 2021, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'id-6'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Series production at Emden from 2023.
UPDATE "vehicle_models"
SET "year_from" = 2023, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'id-7'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- FAW-Volkswagen launched the e-Bora in 2019.
UPDATE "vehicle_models"
SET "year_from" = 2019, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'e-bora'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Production at Palmela from 2017.
UPDATE "vehicle_models"
SET "year_from" = 2017, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 't-roc'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Atlas/Teramont series production at Chattanooga from 2016-12-14.
UPDATE "vehicle_models"
SET "year_from" = 2016, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'teramont'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Produced since 2007.
UPDATE "vehicle_models"
SET "year_from" = 2007, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'tiguan'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Series production from autumn 2002.
UPDATE "vehicle_models"
SET "year_from" = 2002, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'touareg'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- From 2017; the liftback ended in March 2024 but the Shooting Brake continued, so no end year.
UPDATE "vehicle_models"
SET "year_from" = 2017, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'arteon'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- Revealed in China in 2024.
UPDATE "vehicle_models"
SET "year_from" = 2024, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'tharu-xr'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;

-- SAIC Volkswagen launched it in June 2023.
UPDATE "vehicle_models"
SET "year_from" = 2023, "year_to" = NULL, "updated_at" = NOW()
WHERE "id" = 'lavida-xr'
  AND "make_id" = 'volkswagen'
  AND "variant_of_model_id" IS NULL
  AND "year_from" IS NULL
  AND "year_to" IS NULL;
