# Favorites sync API

This change adds account-owned favorites to the Mator API. It is based on backend main `3e9fef5930dcc92e1b01e8e103b397e80761824b`; the migration is additive and named `20261120000000_user_favorites` so it follows the current main migration `20261119000000_vehicle_image_lifecycle`.

## Mobile contract

All routes require a valid bearer access token. Ownership comes from the authenticated JWT principal; clients cannot select another account.

- `GET /v1/me/favorites?limit=50&pageToken=...` returns `{ "items": [{ "partId": "…", "createdAt": "…" }], "nextPageToken": null }`.
- `PUT /v1/me/favorites/:partId` idempotently adds a favorite and returns `{ "partId": "…", "createdAt": "…" }`.
- `DELETE /v1/me/favorites/:partId` removes the caller's favorite and returns `204`.
- `POST /v1/me/favorites/import` accepts `{ "importId": "…", "partIds": ["…"] }` and returns `{ "acceptedIds": [], "missingIds": [] }`. Replaying an import ID returns its stored result.

The app RC transport in `services/favorites-api.ts` matches the GET/PUT/DELETE contract. The RC currently has `FAVORITES_SYNC_CONTRACT_VERIFIED = false`; keep synchronization disabled until this backend change is deployed and mobile explicitly enables it. The import endpoint is available for a future migration flow and is not used by the current RC transport.

## Persistence and authorization

Favorites are keyed by user and part. Reads, writes, deletes, pagination cursors, and import receipts are scoped to the authenticated user. Hidden or unavailable catalog listings are not exposed as active favorites. Account deletion removes related favorites and import receipts inside the existing deletion transaction/locking path.

## Validation and rollout

Validated on a disposable local PostgreSQL/Redis environment with synthetic accounts and listings only: Prisma client generation, all 83 migrations applied, backend build, full Jest suite (346 suites / 7,157 tests), 31 local harness checks, and 14 HTTP checks through the real JWT guard and OTP login flow. No production data or SMS was used.

Apply the additive migration after the current `20261119000000_vehicle_image_lifecycle` migration, deploy the backend routes, verify them in the target environment, and only then enable mobile favorites sync. The migration has not been applied to production. Rollback should disable the mobile feature and revert backend code while retaining the additive tables until a separately reviewed data-retention decision.
