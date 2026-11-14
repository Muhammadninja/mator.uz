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

## Production pre-deployment checklist

Run these from the authorized production backend host, with the production secret manager providing `DIRECT_URL` and `DATABASE_URL`. Do not print either value or enable shell tracing. These steps are preparation only; a production owner executes them during an approved window.

1. Record the running backend SHA, deployment identifier, current migration status, and time. Confirm the checked-out release contains this PR and `20261120000000_user_favorites`.
2. Take a PostgreSQL custom-format backup using the direct connection, store it in the approved encrypted/off-host backup location, and verify its archive listing before proceeding:

   ```bash
   set +x
   : "${DIRECT_URL:?Set from the production secret manager}"
   : "${BACKUP_FILE:?Set an approved encrypted backup destination}"
   pg_dump --format=custom --no-owner --file="$BACKUP_FILE" "$DIRECT_URL"
   pg_restore --list "$BACKUP_FILE" >/dev/null
   ```

   Record the backup checksum and verify the backup job reports success. Do not put the connection string or backup contents in logs or a PR.
3. From `Backend/`, run `npx prisma migrate status` with production `DIRECT_URL`. It must show no failed migrations and a known, reviewed pending set. Confirm `20261112000000_order_idempotency` is already applied before deploying any backend order code that reads/writes the `order_idempotency` table; also confirm every earlier migration is applied. The favorites release adds `20261120000000_user_favorites` after `20261119000000_vehicle_image_lifecycle`.

   Read-only spot check of the three release-relevant records (before rollout, favorites should be pending; idempotency and migration 19 must be applied):

   ```sql
   SELECT migration_name, started_at, finished_at, rolled_back_at
   FROM _prisma_migrations
   WHERE migration_name IN (
     '20261112000000_order_idempotency',
     '20261119000000_vehicle_image_lifecycle',
     '20261120000000_user_favorites'
   )
   ORDER BY migration_name;
   ```
4. If history is out of sync, a migration failed, or earlier unapplied migrations are not part of the reviewed release, stop. Do not baseline, `migrate resolve`, use `db push`, or hand-edit `_prisma_migrations` as part of this release.
5. After approval, deploy the reviewed code/migration and run `npx prisma migrate deploy` with `DIRECT_URL`; check exit status and `npx prisma migrate status` before starting/reloading the app. This migration creates only two new tables, indexes, and foreign keys; it does not rewrite existing rows. Treat the migration as forward-only. For app rollback, disable the mobile feature and roll backend code back while retaining these tables. Do not drop the tables or restore the production backup as a routine rollback.

## Authenticated post-deployment smoke test

Run only after deployment approval, using a dedicated synthetic QA account with a valid bearer token and an already-public, safe catalog part reserved for QA. Start with an empty favorites list for that account. Never use a customer account or trigger real OTP/SMS as part of this smoke test. The test adds one favorite and removes it again; it does not modify catalog inventory.

Provide `API_BASE` (scheme + host, no trailing slash), `FAVORITES_QA_BEARER`, and `FAVORITES_QA_PART_ID` through the operator's secret/session environment. Keep shell tracing off so the token is not logged.

```bash
set +x
: "${API_BASE:?}"
: "${FAVORITES_QA_BEARER:?}"
: "${FAVORITES_QA_PART_ID:?}"
AUTH_HEADER="Authorization: Bearer ${FAVORITES_QA_BEARER}"
PART_PATH="/v1/me/favorites/${FAVORITES_QA_PART_ID}"

# Auth boundary: no bearer must be rejected.
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$API_BASE/v1/me/favorites?limit=50")"
test "$CODE" = 401

# Dedicated synthetic QA account must start empty.
BEFORE="$(curl -fsS -H "$AUTH_HEADER" "$API_BASE/v1/me/favorites?limit=50")"
printf '%s' "$BEFORE" | jq -e '.items == [] and .nextPageToken == null' >/dev/null

# PUT acknowledges the exact part, GET returns it, DELETE is 204, and a final GET is empty.
ADDED="$(curl -fsS -X PUT -H "$AUTH_HEADER" "$API_BASE$PART_PATH")"
printf '%s' "$ADDED" | jq -e --arg id "$FAVORITES_QA_PART_ID" '.partId == $id and (.createdAt | type == "string")' >/dev/null
AFTER_ADD="$(curl -fsS -H "$AUTH_HEADER" "$API_BASE/v1/me/favorites?limit=50")"
printf '%s' "$AFTER_ADD" | jq -e --arg id "$FAVORITES_QA_PART_ID" '.items | any(.[]; .partId == $id)' >/dev/null
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "$AUTH_HEADER" "$API_BASE$PART_PATH")"
test "$CODE" = 204
AFTER_DELETE="$(curl -fsS -H "$AUTH_HEADER" "$API_BASE/v1/me/favorites?limit=50")"
printf '%s' "$AFTER_DELETE" | jq -e '.items == [] and .nextPageToken == null' >/dev/null
```

Record only the target environment, UTC time, deployed SHA, migration status, and pass/fail for each request. Redact bearer tokens and avoid saving response bodies containing account information. If any assertion fails, keep the mobile sync flag disabled and capture sanitized server logs for investigation.

## Production review procedure: `part_stock_6348`

This listing is publicly visible as title `Test`, price 1 UZS. Public API evidence does not establish whether it is synthetic or an intended listing. Do not delete it or edit inventory as part of this review.

1. Capture the read-only public detail response and current public listing status for `GET /v1/catalog/parts/part_stock_6348` with timestamp and deployed API SHA.
2. Have the catalog/data owner inspect `catalog_parts.id = 'part_stock_6348'`, its `catalog_sellers` row, and the corresponding `stocks`/`products` source rows. The ID suffix maps to stock ID 6348. This read-only query returns the listing and source provenance without seller contact data:

   ```sql
   SELECT cp.id, cp.title, cp.price_uzs, cp.in_stock, cp.stock_qty,
          cp.seller_id, cs.name AS catalog_seller_name,
          cs.status AS catalog_seller_status,
          s.id AS stock_id, s.source_system, s.source_code,
          s.quantity AS source_quantity, s.price_uzs AS source_price_uzs,
          p.id AS product_id, p.title AS source_title, p.gm_number,
          p.source_part_number, p.part_number_type
   FROM catalog_parts cp
   LEFT JOIN catalog_sellers cs ON cs.id = cp.seller_id
   LEFT JOIN stocks s ON s.id = CASE
     WHEN cp.id ~ '^part_stock_[0-9]+$'
       THEN substring(cp.id FROM '^part_stock_([0-9]+)$')::integer
     ELSE NULL
   END
   LEFT JOIN products p ON p.id = s.product_id
   WHERE cp.id = 'part_stock_6348';
   ```

   Also check the seller/source audit trail in the owning system and the listing's first public appearance. Do not export seller contact or unrelated customer data into the review artifact.
3. Ask the source owner to confirm whether it is a QA fixture, accidental publication, or legitimate listing. Preserve the row and history while the source is unresolved.
4. If confirmed synthetic or accidentally published, keep the record and audit history. The current backend has no listing-specific `isPublished`/unpublish field or per-part moderation route: buyer visibility is controlled at storefront level, so suspending the seller would also hide that seller's other listings. Do not suspend the storefront, delete the catalog projection, set stock to zero as a proxy for unpublishing, or change source inventory without the source owner's approval. The catalog owner must choose an authorized source-system correction or request a reversible listing-level suppression mechanism before taking the item out of public view.
5. If confirmed legitimate, the listing owner must provide the correct title, price, stock/availability, category, and provenance; have the authorized catalog operator correct those source fields through the normal source-of-truth workflow, then verify the public response. Do not patch only the projection row because the next projection can overwrite it.

Owner action required: classify the listing from its source and authorize the matching unpublish or source correction. Until then, treat it as a public catalog data defect and preserve the record unchanged.
