-- Reconcile admin_audits with the AdminAudit schema. Production's admin_audits
-- table was built from an incomplete history (columns from add_admin_auth and
-- add_admin_dealers never fully landed), so audit writes/reads 500 on the first
-- missing column — request_id being the one currently thrown.
--
-- This asserts EVERY nullable column the model declares, so whatever is missing
-- (request_id, actor_label, the change-snapshot columns, …) is added and every
-- already-present column is a clean no-op. Fully idempotent: safe on a correct
-- database, curative on a drifted one. NOT NULL columns without a default (id,
-- action) are intentionally omitted — the table exists and is queried, so they
-- are already present; adding them would need a default the model doesn't define.
--
-- Enum-typed columns reference AdminRole (from add_admin_auth) and
-- AdminAuditEntity (ensured by 20260728000100); both exist by the time this runs.

ALTER TABLE "admin_audits"
  ADD COLUMN IF NOT EXISTS "actor_id" TEXT,
  ADD COLUMN IF NOT EXISTS "actor_email" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "actor_name" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "actor_label" VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "target_admin_id" TEXT,
  ADD COLUMN IF NOT EXISTS "target_email" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "target_name" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "previous_role" "AdminRole",
  ADD COLUMN IF NOT EXISTS "new_role" "AdminRole",
  ADD COLUMN IF NOT EXISTS "target_entity" "AdminAuditEntity",
  ADD COLUMN IF NOT EXISTS "target_entity_id" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "previous_values" JSONB,
  ADD COLUMN IF NOT EXISTS "new_values" JSONB,
  ADD COLUMN IF NOT EXISTS "reason" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "ip" VARCHAR(45),
  ADD COLUMN IF NOT EXISTS "user_agent" VARCHAR(400),
  ADD COLUMN IF NOT EXISTS "request_id" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Covering indexes the trail is read by (also from add_admin_auth). Idempotent.
CREATE INDEX IF NOT EXISTS "admin_audits_target_admin_id_created_at_idx"
  ON "admin_audits"("target_admin_id", "created_at");
CREATE INDEX IF NOT EXISTS "admin_audits_actor_id_created_at_idx"
  ON "admin_audits"("actor_id", "created_at");
CREATE INDEX IF NOT EXISTS "admin_audits_created_at_idx"
  ON "admin_audits"("created_at");
