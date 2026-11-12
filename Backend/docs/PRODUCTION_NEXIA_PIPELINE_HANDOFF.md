# Mator production handoff: Nexia and vehicle images

**Status: administrator execution required.** Production access was unavailable to this audit. No production migration, deployment, database query, or TestFlight submission was performed here. Run this only from an authorized server session, and keep credentials in the administrator's secret manager or shell environment. Do not paste credentials or connection strings into logs, PRs, or this document.

## Release inputs

- Backend PR #133 contains migration `20261115000000_vehicle_model_variants`.
- The image integration uses migration `20261113000000_vehicle_image_integration`.
- Apply the image integration migration first, then the Nexia variants migration. The Nexia migration depends on the catalog/schema context produced by the earlier migration/release.
- Confirm the checked out backend commit is the approved, validated PR head. Do not deploy an unmerged or unverified commit.
- Vehicle image integration is disabled by default. Keep it disabled unless its config and cost behavior have been reviewed and explicitly authorized. Enabling it against a generation provider may incur paid calls.
- The Nexia flow does not decode VINs on the backend. A supported frontend decoder result resolves to canonical catalog model `nexia-3`; otherwise retain the year/owner-choice flow. Do not infer a generation from VIN year alone.

## 1. Establish target and backup

1. Confirm this is the intended production environment and record the currently deployed backend SHA, schema version, PM2 process names, Redis endpoint identity (without secrets), and pipeline version.
2. Take a PostgreSQL custom-format backup before any migration. Store it in the approved protected backup location, record its timestamp and checksum, and verify it can be listed/restored to an isolated database.
3. Confirm the backup covers all application data and that restore credentials/access are available to the on-call administrator.

## 2. Inspect migration ledger and schema

1. Read-only inspect `_prisma_migrations` and run `npx prisma migrate status` against the intended database using the direct migration connection (`DIRECT_URL`). Do not print connection strings.
2. Confirm the production baseline has been reconciled according to `Backend/docs/PRODUCTION_BASELINE.md`. If it has not, or Prisma reports drift, missing historical migrations, or failed migrations, stop and follow that baseline procedure with the database owner. Do not run `migrate deploy` blindly.
3. Confirm whether `20261113000000_vehicle_image_integration` and `20261115000000_vehicle_model_variants` are applied, pending, or failed. Inspect schema and existing rows before proceeding; do not edit migration SQL or mark migrations applied merely to bypass an error.
4. Validate that the checked-out migration files are ordered as above. Review the Nexia SQL against current production model/vehicle rows and the migration's documented rollback behavior.

## 3. Deploy in compatible order

1. Use the repository's production procedure (`Backend/docs/DEPLOYMENT.md`): install locked dependencies, generate Prisma client, build, and deploy the reviewed application code. Never use `migrate dev`, `db push`, or `migrate reset` against production.
2. Run `npx prisma migrate deploy` only after the status, baseline, backup, and migration review gates above pass. It applies pending migrations in folder order: image integration (`20261113000000`), then Nexia variants (`20261115000000`). Capture sanitized command outcome and re-run `migrate status`.
3. Restart/reload the backend using its existing PM2 ecosystem configuration, then verify the expected backend processes and liveness/readiness endpoints before routing traffic.
4. Keep the vehicle image pipeline feature disabled unless approved configuration is present. Do not invoke generation jobs during verification.

## 4. Verify services and API behavior

- **PM2:** inspect process status, restart counts, and recent sanitized logs for backend and the existing image pipeline process. Keep the backend's configured single fork instance.
- **Redis / BullMQ:** verify Redis responds to `PING`; inspect the `vehicle-images` queue and worker registration, stalled/failed counts, and scheduler health. Confirm the relay and sync schedulers are active only if the integration is intentionally enabled. Do not enqueue a generation request as a health check.
- **Pipeline:** verify the internal service is reachable only through its configured private/loopback path, authenticated service-to-service health/resolve checks work, its private staging remains private, and Cloudinary is used only for approved publication. Check that no unapproved asset is publicly exposed.
- **Authenticated Garage checks:** with an authorized test account, create/list/get a vehicle and retrieve its image state. Verify existing approved Chevrolet assets still resolve. For Nexia, verify 2009–2015 resolves to Nexia 2; 2016 presents both choices until a choice is saved; 2017–2022 resolves to Nexia 3; unsupported years remain unresolved. Save each 2016 choice, refetch the Garage record, and confirm persistence. Test supported Nexia VIN decoding through the app and confirm the canonical `nexia-3` catalog ID; an undecoded/ambiguous VIN must not override year/owner choice. Do not modify fitment fields.
- **No paid generation:** use an already approved image identity or a test request with the image integration disabled. Verify retrieval only. Confirm provider call counters/logs show no generation invocation.
- **Core health:** check catalog/reference endpoints, authenticated checkout quote/preview, and order create/read using the approved non-charging test path. Do not capture a real payment or change payment configuration. Confirm order and checkout logs have no new errors.

## 5. Rollback

1. If application checks fail, stop traffic to the new backend and roll the application back to the previously recorded backend artifact/commit. Preserve logs and the database backup.
2. The image integration migration is additive and the older application ignores its added state. Keep the feature disabled during rollback; do not drop the new tables/columns as an emergency step.
3. Do not blindly reverse the Nexia migration: it may have populated generation relationships and year ranges. If rollback is required, stop writes to the affected catalog, take a fresh backup, inspect affected vehicle/catalog rows, and use a reviewed reverse procedure with the backend/database owner. Preserve saved owner choices and existing Garage records. Never delete data or use `migrate resolve` to conceal a failed migration.
4. If recovery requires database restoration, restore to a separate verified target first, validate application compatibility, then follow the production database owner's cutover procedure.
5. Keep approved Cloudinary assets and the pipeline's private review data intact. Roll back code/config pointers; do not bulk-delete assets or queue data.

## Completion record

The administrator should record the deployed backend SHA, migration statuses, backup identifier/checksum, PM2/Redis/worker health, sanitized Garage and checkout test outcomes, whether generation remained disabled, and any rollback action. Production is verified only after these checks actually pass.
