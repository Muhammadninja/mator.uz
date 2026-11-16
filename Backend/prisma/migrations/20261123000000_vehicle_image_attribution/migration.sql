-- Persist source credit and license terms alongside an approved sourced image.
ALTER TABLE "vehicle_image_identities"
  ADD COLUMN "image_license" VARCHAR(80),
  ADD COLUMN "image_license_url" VARCHAR(2048),
  ADD COLUMN "image_author" VARCHAR(500),
  ADD COLUMN "image_attribution" VARCHAR(1000),
  ADD COLUMN "image_source_page" VARCHAR(2048),
  ADD COLUMN "image_source_title" VARCHAR(500),
  ADD COLUMN "image_modifications" VARCHAR(500);
