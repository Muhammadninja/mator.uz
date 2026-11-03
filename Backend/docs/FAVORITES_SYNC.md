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
guard. At this first checkpoint identity-provider JWT verification, frontend-to-backend/native UI,
production deployment, and production API checks were unverified; local follow-up is below. Local
results are not production integration confirmation. Real accounts, production
schema/data, orders and payments were untouched.

## Local frontend transport follow-up

`scripts/serve-favorites-local.cjs` is a loopback-only integration harness, not
an application deployment entry point. It fixes PostgreSQL to the disposable
v3 database and Redis to port 56379/database 14 with a per-run namespace. It
never reads `.env`, invokes no phone/SMS providers, uses ephemeral RS256 keys,
and admits only its two synthetic fixture phone numbers through its OTP stub.
The real `JwtStrategy`, `JwtAuthGuard`, `TokenService`, `AuthController`,
`FavoritesController/Service` and catalog parts controller/service run unchanged.
The profile/legal status fixture endpoints are harness-specific; legal status
simulates pre-existing consent and does not constitute consent recording tests.
Sessions are written only to `/tmp/mator-favorites-http-fixture.json` mode 0600.
Stop the process only after native checks finish; shutdown removes its users,
refresh tokens, parts, seller, category and protected fixture file.

On 2026-11-02 the frontend agent executed its actual transport/api-client/sync
harness against this server: **4 tests passed**, covering two-account/guest
isolation, durable offline/relaunch and a lost-PUT retry, plus delayed GET after
logout, and import receipt replay after removal without reinsertion (changed
payload 409, account B isolation, cold restart after unlike). A separate backend-side HTTP smoke verified **9 auth/catalog responses**:
OTP, RS256 principal resolution, missing-token denial, profile, synthetic consent
status, catalog detail, refresh, logout and Redis access-token revocation.
Root independently verified native behavior on a separate iPhone 16 Pro Max /
iOS 18.3 simulator using local port 3304: account A added part 0 (API A0/B empty),
removed it, then added part 1 while the backend was paused. After the request
failed, the app was terminated, the backend resumed and a cold launch showed
only part 1 (API A1/B empty). Logout showed empty guest favorites. Account B
started empty, added part 2 and retained only part 2 after a cold launch.
After logout B/login A, the UI showed only part 1, excluding removed part 0 and
B's part 2. The final state was guest after A logout. No legacy import was
attempted, pending the user's migration-policy decision. No order/cart buttons
were touched. Images were expected synthetic placeholders; this is not
production design verification. These are local results only.
The native harness also supplies public `/v1/legal/documents` and versioned detail
with explicit `LOCAL TEST ONLY` nonbinding synthetic content. It records no
consents and exposes no legal-acceptance mutation. OTP is allowed only for its
two pre-existing synthetic users; it never creates arbitrary phone accounts.

The protected runtime fixture includes provenance marker
`kind: mator-favorites-disposable-http-v1` and `disposable: true` per account;
the HTTP harness refuses destructive fixture cleanup without these markers.

After native completion the frontend HTTP harness passed all four scenarios
with provenance enforcement, then cleared only the two disposable users' saved
favorites. The server was stopped and scoped cleanup verified: synthetic users,
parts, favorites, import receipts and run-namespaced Redis keys all zero; protected
fixture file absent. Other local services/database schemas were retained.

Minimal native bridge limitations: Garage, cart, orders, notifications, sales,
reference/config and device registration were not mounted and returned 404 to
background reads. `/v1/legal/accept` returned 404 and no legal acceptance was
written. These endpoints and photo/design quality were not verified by this
favorites harness. The production feature code was unchanged during this phase;
only harness syntax (`node --check`) and `git diff --check` were rerun.
