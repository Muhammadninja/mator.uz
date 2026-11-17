-- Manual vehicles: a make or model the catalog does not list is stored by name,
-- never under a fabricated catalog id. Additive and backward compatible: every
-- existing row has make_id and model_id and no custom names, which the CHECK
-- accepts, and old code that always writes both ids keeps working.
ALTER TABLE "vehicles" ALTER COLUMN "make_id" DROP NOT NULL;
ALTER TABLE "vehicles" ALTER COLUMN "model_id" DROP NOT NULL;
ALTER TABLE "vehicles" ADD COLUMN "custom_make_name" VARCHAR(60);
ALTER TABLE "vehicles" ADD COLUMN "custom_model_name" VARCHAR(60);

-- Either a catalog vehicle (both ids, no names) or a manual one: a custom model
-- name with exactly one make source (catalog make_id XOR custom make name).
-- Names are never blank.
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_make_model_source"
CHECK (
  (
    "make_id" IS NOT NULL AND "model_id" IS NOT NULL
    AND "custom_make_name" IS NULL AND "custom_model_name" IS NULL
  )
  OR (
    "model_id" IS NULL
    AND "custom_model_name" IS NOT NULL AND btrim("custom_model_name") <> ''
    AND (
      ("make_id" IS NOT NULL AND "custom_make_name" IS NULL)
      OR ("make_id" IS NULL AND "custom_make_name" IS NOT NULL AND btrim("custom_make_name") <> '')
    )
  )
);
