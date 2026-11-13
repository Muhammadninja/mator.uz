-- The Garage generation resolver reads these rows from vehicle_models. Older
-- production databases may already have them; a clean database created from
-- the checked-in reference seed does not. Insert only missing rows, then verify
-- the global ids are still Chevrolet Nexia entries before setting their visual
-- generation range. Part fitment tables and vehicle model ids are untouched.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "vehicle_models"
    WHERE "id" = 'nexia' AND "make_id" = 'chevrolet'
  ) THEN
    RAISE EXCEPTION 'Cannot create Nexia generation rows: Chevrolet Nexia base row is missing';
  END IF;

  INSERT INTO "vehicle_models" ("id", "make_id", "name", "sort_order")
  VALUES
    ('nexia-1', 'chevrolet', 'Nexia 1', 1001),
    ('nexia-2', 'chevrolet', 'Nexia 2', 1002),
    ('nexia-3', 'chevrolet', 'Nexia 3', 1003)
  ON CONFLICT ("id") DO NOTHING;

  UPDATE "vehicle_models" AS generation
  SET "year_from" = mapping."year_from",
      "year_to" = mapping."year_to",
      "variant_of_model_id" = 'nexia'
  FROM (VALUES
    ('nexia-1', 'Nexia 1', 1996, 2008),
    ('nexia-2', 'Nexia 2', 2008, 2016),
    ('nexia-3', 'Nexia 3', 2016, 2022)
  ) AS mapping("id", "name", "year_from", "year_to")
  WHERE generation."id" = mapping."id"
    AND generation."make_id" = 'chevrolet'
    AND generation."name" = mapping."name";

  IF (
    SELECT count(*) FROM "vehicle_models"
    WHERE "make_id" = 'chevrolet'
      AND "variant_of_model_id" = 'nexia'
      AND ("id", "name", "year_from", "year_to") IN (
        ('nexia-1', 'Nexia 1', 1996, 2008),
        ('nexia-2', 'Nexia 2', 2008, 2016),
        ('nexia-3', 'Nexia 3', 2016, 2022)
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'Nexia generation ids are occupied by unexpected rows; refusing to apply catalog ranges';
  END IF;
END $$;
