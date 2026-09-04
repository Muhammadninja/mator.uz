-- Dealer 1C integration credential (POST /v1/integrations/dealers/sync-inventory).
--
-- Purely ADDITIVE: four nullable columns on an existing table, plus one unique
-- index. No column is dropped, renamed or retyped, nothing is backfilled, and
-- every existing row keeps its exact meaning — an unconfigured dealer simply
-- carries four NULLs, which is precisely "no integration". Safe to apply to a
-- live database: adding a nullable column with no default is a catalog-only
-- change in PostgreSQL (no table rewrite).
--
-- Only the SHA-256 DIGEST of the key is stored, never the key. The endpoint is
-- machine-to-machine, so its credential is a bearer secret in a header: whoever
-- holds it can rewrite the dealer's stock and prices. Keeping only the digest
-- means a database leak yields no working keys — the same reasoning as
-- app_admins.password_hash. The plaintext is shown exactly once, at issue time.

ALTER TABLE "catalog_sellers"
  ADD COLUMN "api_key_hash"          VARCHAR(64),
  ADD COLUMN "api_key_last4"         VARCHAR(4),
  ADD COLUMN "api_key_issued_at"     TIMESTAMPTZ(3),
  ADD COLUMN "api_key_last_used_at"  TIMESTAMPTZ(3);

-- UNIQUE so one key resolves to at most one dealer, and so the guard's
-- lookup-by-hash is a single index probe rather than a scan of every dealer.
-- A PostgreSQL unique index treats NULLs as distinct, so the many dealers with
-- no integration configured do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_sellers_api_key_hash_key"
  ON "catalog_sellers" ("api_key_hash");

-- Audit actions for the key's lifecycle. Neither entry ever carries the key or
-- its digest — only the display suffix and the timestamps — so the trail records
-- who issued or revoked a credential without becoming a place to read it back.
--
-- IF NOT EXISTS makes each ADD VALUE idempotent. PostgreSQL 12+ allows
-- ALTER TYPE ... ADD VALUE inside a transaction block as long as the new value
-- is not USED in that same transaction; nothing here writes an audit row, so
-- this is safe in Prisma's transactional migration runner.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_API_KEY_ISSUED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_API_KEY_REVOKED';
