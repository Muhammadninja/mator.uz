-- ING-001. Additive only: a nullable column, so no existing row is rewritten and
-- application code from before this migration keeps working.
-- Deploy this migration BEFORE the application version that reads it.

-- AlterTable
ALTER TABLE "stocks" ADD COLUMN     "projection_pending" JSONB;
