-- Account deletion (DELETE /v1/me) + exact avatar cleanup.
--
-- Purely ADDITIVE: two nullable columns on app_users. Nothing is dropped,
-- renamed, retyped or backfilled, and every existing row keeps its meaning —
-- a live account simply has both columns NULL, which is what they mean.
--
-- ── Why `deleted_at` and not a DELETE ──
-- Apple requires an account-creation app to offer account deletion, but orders
-- must be retained for financial/legal records and orders.user_id is NOT NULL
-- with ON DELETE RESTRICT. Dropping the app_users row is therefore impossible
-- for any user who has ever ordered, and adding ON DELETE SET NULL would mean
-- widening orders.user_id to nullable and rewriting every order query.
--
-- So deletion is implemented as IRREVERSIBLE ANONYMIZATION of the app_users row
-- (every personal field overwritten in the same transaction that sets this
-- column) plus a hard DELETE of every other personal-data relation. The row that
-- survives is a tombstone carrying no personal data — only the key the retained
-- orders point at.
--
-- `deleted_at` is the authoritative "this account is gone" flag: JwtStrategy
-- rejects any token whose user carries it, so a deleted account can never
-- authenticate again even though its row still exists.
--
-- ── Why `avatar_public_id` ──
-- Deleting a Cloudinary asset requires its public_id. Deriving one from the
-- secure URL is fragile and wrong in general (version segments, nested folders,
-- transformation components, and a format suffix that is NOT part of the id), so
-- the id the upload response already returns is stored instead — the same value
-- the draft-image pipeline persists for product images. NULL for avatars
-- uploaded before this column existed and for users with no avatar; cleanup
-- simply skips those rather than guessing an id and risking deleting the wrong
-- asset.

ALTER TABLE "app_users"
  ADD COLUMN "avatar_public_id" TEXT,
  ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

-- Indexed so deleted accounts can be enumerated cheaply (retention/audit) and so
-- the column matches the Prisma model exactly — Prisma cannot express a partial
-- index, and a hand-written `WHERE deleted_at IS NOT NULL` here would make every
-- future `prisma migrate diff` report permanent drift.
CREATE INDEX "app_users_deleted_at_idx" ON "app_users" ("deleted_at");
