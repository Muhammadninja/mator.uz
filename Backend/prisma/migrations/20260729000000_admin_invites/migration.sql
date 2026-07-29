-- Invite-only admin signup. Purely ADDITIVE: two NEW enum values on
-- AdminAuditAction + one NEW table `admin_invites`. No existing table is
-- altered, so the login/session/audit machinery is byte-for-byte untouched.
--
-- A SUPER_ADMIN invites a specific email; a one-time, expiring link is emailed;
-- the invitee sets a password and their app_admins row is created. admin_invites
-- stores ONLY the SHA-256 hash of each opaque token (raw value lives only in the
-- emailed link), is single-use (accepted_at) and short-lived (expires_at), and
-- its inviter FK is ON DELETE SET NULL so removing the inviter never erases a
-- pending invite or its record.

-- The two new audit verbs. Kept in their own statements, IF NOT EXISTS, exactly
-- like 20260728000000_dealer_audit_enum_values: PostgreSQL forbids an
-- `ALTER TYPE ... ADD VALUE` from sharing a transaction with a *use* of the new
-- value, and on an environment where these already landed this is a clean no-op.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'INVITE_ADMIN';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ACCEPT_INVITE';

-- CreateTable
CREATE TABLE "admin_invites" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'OPERATOR',
    "invited_by_id" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_invites_token_hash_idx" ON "admin_invites"("token_hash");

-- CreateIndex
CREATE INDEX "admin_invites_email_idx" ON "admin_invites"("email");

-- AddForeignKey
ALTER TABLE "admin_invites" ADD CONSTRAINT "admin_invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "app_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
