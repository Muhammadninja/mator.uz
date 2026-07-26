-- Admin-panel authentication. Purely ADDITIVE: one NEW enum + two NEW tables,
-- zero changes to any existing table. `app_users` and `refresh_tokens` — and
-- therefore the entire mobile OTP flow — are byte-for-byte untouched.
--
-- app_admins is a separate identity space: staff accounts that log in with
-- email + password (bcrypt hash only, never plaintext). admin_refresh_tokens
-- stores ONLY the SHA-256 hash of each opaque refresh token, mirrors the
-- rotation/reuse-detection design of refresh_tokens (soft-consume via
-- consumed_at + token_version), and cascades on admin deletion so no row is
-- ever orphaned. There is no FK between the two identity spaces by design.

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'MANAGER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "AdminAuditAction" AS ENUM ('CREATE_ADMIN', 'DEACTIVATE_ADMIN', 'REACTIVATE_ADMIN', 'CHANGE_ROLE', 'CHANGE_PASSWORD', 'RESET_PASSWORD', 'DELETE_ADMIN');

-- CreateTable
CREATE TABLE "app_admins" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'OPERATOR',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_admins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_admins_email_key" ON "app_admins"("email");

-- CreateTable
-- One row per SESSION, not per admin: each login inserts a new row, so multiple
-- devices hold independent sessions that never evict one another. device_name /
-- ip / user_agent are display-only provenance for an "active sessions" list and
-- are never used for an authorization decision. revoked_at is kept separate from
-- consumed_at: consumed = rotated normally, revoked = deliberately killed, and
-- only a replayed *consumed* token is a theft signal.
CREATE TABLE "admin_refresh_tokens" (
    "id" SERIAL NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "admin_id" TEXT NOT NULL,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "device_name" VARCHAR(120),
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(400),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_refresh_tokens_token_hash_key" ON "admin_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "admin_refresh_tokens_admin_id_idx" ON "admin_refresh_tokens"("admin_id");

-- CreateIndex
CREATE INDEX "admin_refresh_tokens_expires_at_idx" ON "admin_refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "admin_refresh_tokens" ADD CONSTRAINT "admin_refresh_tokens_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "app_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only audit trail for critical administrator actions.
--
-- Actor and target identities are SNAPSHOTS taken at write time (the same
-- pattern as order_status_history.actor_name), so an entry keeps saying who did
-- what to whom even after either account is renamed or deleted.
--
-- BOTH foreign keys are ON DELETE SET NULL, deliberately NOT CASCADE: deleting
-- an administrator must never erase the record of what they did — or of their
-- own deletion — otherwise the trail could be destroyed simply by removing the
-- account. The snapshot columns are what keep such an entry readable.
CREATE TABLE "admin_audits" (
    "id" TEXT NOT NULL,
    "action" "AdminAuditAction" NOT NULL,
    "actor_id" TEXT,
    "actor_email" VARCHAR(255),
    "actor_name" VARCHAR(120),
    "actor_label" VARCHAR(60),
    "target_admin_id" TEXT,
    "target_email" VARCHAR(255),
    "target_name" VARCHAR(120),
    "previous_role" "AdminRole",
    "new_role" "AdminRole",
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(400),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_audits_target_admin_id_created_at_idx" ON "admin_audits"("target_admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audits_actor_id_created_at_idx" ON "admin_audits"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audits_created_at_idx" ON "admin_audits"("created_at");

-- AddForeignKey
ALTER TABLE "admin_audits" ADD CONSTRAINT "admin_audits_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audits" ADD CONSTRAINT "admin_audits_target_admin_id_fkey" FOREIGN KEY ("target_admin_id") REFERENCES "app_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
