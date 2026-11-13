-- Garage identity snapshot: what a vehicle was resolved to when it was added (the
-- catalog row it is pictured as, and the verified generation, facelift and market
-- from the vehicle image registry), so a later catalog edit can never reassign a
-- saved vehicle.
--
-- Additive only: four NULLABLE columns with no default (no table rewrite, no lock
-- beyond the brief ALTER), no index, no foreign key, no data change. Existing
-- vehicles keep NULL and read as identity "unresolved"; fitment never reads these.
--
-- Deploy order: apply this migration BEFORE deploying the code that writes and
-- reads the columns. The previous code never touches them.
--
-- Rollback (only after reverting the code):
--   ALTER TABLE "vehicles" DROP COLUMN "identity_model_id", DROP COLUMN "identity_generation_id",
--     DROP COLUMN "identity_facelift_id", DROP COLUMN "identity_market";

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "identity_facelift_id" VARCHAR(64),
ADD COLUMN     "identity_generation_id" VARCHAR(64),
ADD COLUMN     "identity_market" VARCHAR(2),
ADD COLUMN     "identity_model_id" VARCHAR(64);
