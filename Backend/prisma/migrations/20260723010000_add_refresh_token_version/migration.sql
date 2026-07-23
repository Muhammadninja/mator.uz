-- Binds every refresh token to the session version it was minted under, closing
-- the one gap session versioning alone could not: `rotate()` reads the account
-- outside a transaction, so a rotation racing a revocation could CREATE its new
-- refresh row after the revocation's sweep had already run. That row survived
-- the revocation and, on its next rotation, minted a fully valid access token —
-- resurrecting a session logout-all was meant to kill. Rotation now refuses any
-- row whose `token_version` no longer matches the account's, so the race-created
-- row (stamped with the pre-bump version) is dead on arrival.
--
-- Additive and backward-compatible: NOT NULL with DEFAULT 0, matching the
-- default of app_users.token_version, so every existing refresh token stays
-- valid for accounts that have never been revoked.

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "token_version" INTEGER NOT NULL DEFAULT 0;
