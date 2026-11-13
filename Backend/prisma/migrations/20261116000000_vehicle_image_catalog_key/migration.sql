-- Stores the stable catalog key for owner-approved bundled assets that do not
-- require an external publication URL. Existing rows are unchanged.
-- Rollback (only after reverting backend code): ALTER TABLE "vehicle_image_identities" DROP COLUMN "catalog_asset_key";
ALTER TABLE "vehicle_image_identities"
  ADD COLUMN "catalog_asset_key" VARCHAR(96);
