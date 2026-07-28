-- Repair 2/2 for 20260727000000_add_admin_dealers. Adds the generic-target audit
-- columns that did not land on production. Without them, AdminAuditService.record
-- inserts into columns that do not exist and every dealer mutation
-- (certify / lowest-price / approve / suspend / reactivate) fails with a 500.
--
-- Fully idempotent: the AdminAuditEntity enum is created in a guarded block
-- (CREATE TYPE has no IF NOT EXISTS), and every column/index uses IF NOT EXISTS.
-- On an environment where the original migration applied cleanly, this is a no-op.
-- No enum VALUE is added here, so this migration carries no transactional
-- restriction and applies atomically.

-- CreateEnum (guarded — CREATE TYPE has no IF NOT EXISTS)
-- Target kind for audit entries about something other than an admin account.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdminAuditEntity') THEN
    CREATE TYPE "AdminAuditEntity" AS ENUM ('DEALER');
  END IF;
END
$$;

-- AlterTable — the generic target + change-snapshot columns. target_admin_id is
-- an FK to app_admins and cannot hold a dealer id, so a dealer action is recorded
-- via target_entity/target_entity_id instead; previous_values/new_values snapshot
-- exactly the fields the action flipped.
ALTER TABLE "admin_audits"
  ADD COLUMN IF NOT EXISTS "target_entity" "AdminAuditEntity",
  ADD COLUMN IF NOT EXISTS "target_entity_id" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "previous_values" JSONB,
  ADD COLUMN IF NOT EXISTS "new_values" JSONB,
  ADD COLUMN IF NOT EXISTS "reason" VARCHAR(500);

-- CreateIndex — "everything that happened to this dealer", newest first.
CREATE INDEX IF NOT EXISTS "admin_audits_target_entity_target_entity_id_created_at_idx"
  ON "admin_audits"("target_entity", "target_entity_id", "created_at");
