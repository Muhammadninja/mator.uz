# Favorites backend handoff (local only)

Branch `codex/favorites-sync` is based on `da3c19f7`, the search candidate on
current `origin/main` (`c58e38b0`). The rebase preserves current-main account
removal's account-row lock and active-order refusal without changing either.
Favorites and import receipts are explicitly cleared by account removal.

## Contract

All routes use the existing JWT guard and authenticated principal only:

- `GET /v1/me/favorites?limit=50&pageToken=...`: `{items:[{partId,createdAt}],nextPageToken}`.
  Limit 1–100; owner-bound timestamp/ID keyset survives deletion of the cursor row.
- `PUT /v1/me/favorites/:partId`: idempotent add; returns `{partId,createdAt}`.
- `DELETE /v1/me/favorites/:partId`: idempotent owner-scoped remove, HTTP 204.
- `POST /v1/me/favorites/import`: `{importId,partIds}` (at most 100 IDs), returns
  `{acceptedIds,missingIds}`. Additive only. Persist a stable ID and immutable
  batch before HTTP. Replay returns the stored receipt without re-adding parts;
  reuse for a different normalized ID set returns 409. Keep missing IDs locally.

New additions/imports check `BUYER_LISTED_PART` after locking catalog rows:
suspended sellers, missing photos and nonpositive prices are unavailable. Existing
saved hidden IDs remain owned records and are returned by GET, allowing recovery
or removal without exposing somebody else's favorites. Import receipts and
favorites writes serialize on the same user-row lock as account removal.

## Migration and deployment boundary

`20261103000000_user_favorites` creates only `user_favorites` and
`favorite_imports`, with owner composite keys, cascading foreign keys and a
favorites pagination index. It changes no existing rows. No new environment
variables or dependencies. Regenerate Prisma and run `prisma migrate deploy`
when this feature receives its separate deployment approval. Do not deploy this
feature as part of the search-only deployment.

For application rollback, restore the preceding application artifact and keep
the additive tables/data. Do not drop favorite/import-receipt tables during a
rollback: that loses saved data and retry history. No production migration or
production verification has been performed.

## Executed validation

- Independent worktree dependencies installed from current lockfile and Prisma
  6.19.3 client regenerated locally; source worktree client untouched.
- Fresh disposable database `mator_favorites_validation_v3` on local PostgreSQL
  port 55432 applied all **57 migrations**, including the new migration.
- Targeted favorites/account-removal suites: **30 tests passed**.
- `npm run build`: passed.
- `node scripts/check-favorites-local.cjs`: **31 HTTP responses verified** using
  real PostgreSQL and Nest validation/controller/service, synthetic principals
  and synthetic fixtures, cleaned afterward. Covered owner isolation, malformed
  input, duplicate PUT, cross-owner DELETE/cursor, concurrent import, lost-response
  replay after removal, mismatched import payload, missing IDs, timestamp ties,
  removed cursor row, deleted-account stale write, account cleanup, suspended
  seller/no-photo/zero-price rejection, existing hidden favorite preservation.

The local HTTP harness replaces JWT verification with a synthetic principal
guard. Actual identity-provider JWT verification, frontend-to-backend/native UI,
production deployment, and production API checks remain unverified. Local
results are not production integration confirmation. Real accounts, production
schema/data, orders and payments were untouched.
