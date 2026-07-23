-- Session versioning for immediate access-token revocation. Access tokens are
-- stateless RS256 JWTs, so until now the only way to kill a live one was to wait
-- out its 1h TTL. Every issued token now carries the account's `token_version`
-- claim, and JwtStrategy compares it against this column on every authenticated
-- request — bumping the column (logout-all-devices, and later phone change /
-- recovery / admin block / suspicious activity) invalidates every outstanding
-- token at once. Additive and backward-compatible: NOT NULL with DEFAULT 0, so
-- existing rows are backfilled to 0.

-- AlterTable
ALTER TABLE "app_users" ADD COLUMN     "token_version" INTEGER NOT NULL DEFAULT 0;
