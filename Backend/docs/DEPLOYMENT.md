# Deployment & Database Migrations

This backend uses **Prisma Migrate** for versioned schema changes. Migrations
live in [`prisma/migrations/`](../prisma/migrations) and are committed to git.

> History note: the schema was originally managed with `prisma db push` (no
> migration history). The `…_init` migration is a **baseline** generated from
> the current schema. Any database created *before* that baseline existed must
> be reconciled once using the [baseline procedure](#1-existing-database-baseline-one-time)
> below — do **not** run `migrate deploy` against it blindly, or Prisma will try
> to re-create tables that already exist and fail.

## Required environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Pooled Postgres connection used by the app at runtime. |
| `DIRECT_URL` | Direct (non-pooled) connection. **Migrations must use this** — pooled connections (e.g. PgBouncer in transaction mode) break DDL. |
| `NODE_ENV` | Set to `production` in prod. Enables the fail-fast JWT key guard (boot aborts if `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` / `JWT_KID` are missing). |
| `CORS_ORIGINS` | Comma-separated browser-origin allowlist (e.g. `https://app.mator.uz,https://admin.mator.uz`). Empty ⇒ all browser origins rejected. The native mobile app sends no `Origin` and is unaffected. |
| `MARKETPLACE_TIN` | The 9-digit ИНН of ООО «MATOR INNOVATIONS», printed on the delivery line and the service fee line of every Payme receipt. Unset, malformed or YandexGo's, Payme refuses any order with a delivery cost or a service fee, the boot log says so, and everything else works. |
| `SERVICE_FEE_MXIK` | The 17-digit MXIK (ИКПУ) of Mator's service fee, as registered in Tasnif. No default: delivery's code (`10112006002000000`) or a malformed value counts as unset. Until it is set, Payme refuses every order that carries a service fee (above 100 000 of parts) with `FISCAL_DATA_INCOMPLETE`, and the boot log says so. Cash and terminal orders are not affected. |
| `SERVICE_FEE_PACKAGE_CODE` | The Tasnif package (unit) code issued for that MXIK. No default, and delivery's `1542432` counts as unset. Same effect as above while unset. |
| `SERVICE_FEE_VAT_PERCENT` | **No longer read**: remove it from the environment. The service fee is Mator's own line, so it carries Mator's own VAT rate, the system constant `MARKETPLACE_VAT_RATE` = 0, exactly like delivery: ООО «MATOR INNOVATIONS» pays turnover tax and is not registered for VAT. No value here can put another rate on the receipt. |
| `DELIVERY_COVERAGE_POLYGON` | **Where couriers go. No default: unset means courier delivery is off** (`COURIER_DELIVERY_UNAVAILABLE`) and pickup carries on. A single-line GeoJSON `Polygon` or `MultiPolygon` geometry, positions as `[longitude, latitude]`, rings closed, holes allowed, in single quotes in an env file: `'{"type":"Polygon","coordinates":[[[lng,lat],[lng,lat],[lng,lat],[lng,lat]]]}'`. An invalid value aborts boot. A location outside it is refused with `DELIVERY_OUTSIDE_COVERAGE`. The approved launch value, Tashkent City and the New Tashkent project territory and nothing else in Tashkent Region (630.70 km²), is ready to copy from `config/delivery-coverage/delivery-coverage.env.txt`; `delivery-coverage.geojson` beside it is the same geometry. It is a practical reconstruction, not a certified cadastral boundary. Tashkent City (434.73 km²) comes from Senate Resolution SQ-379-IV of 2021-08-27 (Appendix 21 coordinates and the Appendix 22 map), with OSM relation 2216724 as of 2024-03-25 for the sections that agree with the act. The city's detached Mirzo Ulug'bek settlement (3.85 km²) is left out by decision, so addresses there are refused. Point 32 is misprinted in Appendix 21 and was rebuilt from the act's wording: where the Chorbog' 3rd lane meets the line 12 m east of the railway. New Tashkent (196.34 km²) is OSM relation 17389398, version 5, which is community-mapped and not an official publication. Retrieved 2026-11-05: later OSM edits do not reach this value. |
| `UZMAPS_API_KEY` | UzMaps key, used only by the backend, for routing, and for search and reverse geocoding unless the next one is set. With `NODE_ENV=production` and an area set, boot aborts if it is missing. Otherwise courier delivery and address search are refused until it is set, and everything else works. |
| `UZMAPS_SEARCH_API_KEY` | Optional second UzMaps key for search and reverse geocoding. UzMaps meters one monthly allowance per key across all products, so without this, address search and courier pricing draw on the same allowance. |

Prisma reads `directUrl` from the datasource block for migration commands, so no
extra flag is needed as long as `DIRECT_URL` is set.

## Isolated vehicle-image staging backend

The staging backend is a separate loopback-only PM2 process (`mator-backend-staging`, port 3001), configured by `ecosystem.staging.config.js`. It loads only `/etc/mator/backend-staging.env`; the launcher clears inherited PM2/shell variables before starting Node. Install the template from `deploy/staging/backend-staging.env.example` as mode `0600`, owned by the dedicated service account, and replace every placeholder with staging-only values. Keep `VEHICLE_IMAGE_PIPELINE_URL` exactly `http://127.0.0.1:8048` and use the staging pipeline request token. The staging pipeline remains disabled for generation and publication during setup; its provider-call ceiling is explicitly one per UTC day for a separately approved later trial.

Use an isolated PostgreSQL database `mator_staging` and restricted role `mator_backend_staging`; `scripts/staging/create-staging-db.sh --apply` requires `MATOR_STAGING_CONFIRM=mator_staging`, refuses existing targets, and prompts for the role password. Before running it, inspect the script and confirm this is the intended staging PostgreSQL instance. The staging backend also requires a separate Redis instance because this code does not support a Redis DB index or queue prefix. Prepare the service/config/ACL from `deploy/staging/redis-mator-staging.*`; the ACL password must match `REDIS_PASSWORD`. Do not point staging at production Redis. Configure a separate Cloudinary cloud/account and quota: the backend requires Cloudinary credentials at startup and the image path is shared with production, so a separate account is mandatory.

Build the backend, create the database and Redis instance, install the staging env file with mode `0600`, then run `scripts/staging/prisma-staging.sh --status` to confirm the dedicated DB target and migration state. On a fresh staging database only, review seed behavior and run `MATOR_STAGING_CONFIRM=mator_staging scripts/staging/prisma-staging.sh --apply`; this performs `prisma migrate deploy` followed by the reference seed and rejects admin-bootstrap credentials. It never uses `migrate reset`. Start only the staging PM2 definition after owner review. For a non-mutating Garage image check, provide an already-authenticated staging access token and existing synthetic Garage vehicle ID to `scripts/staging/vehicle-image-smoke.mjs` with `MATOR_STAGING_CONFIRM=vehicle-image-staging`; it checks backend, pipeline and the existing vehicle image status without adding a vehicle or queuing generation.

Provider requirements for any later controlled generation trial: an owner-approved staging provider, model that supports the pipeline's image and transparency requirements, staging-only API credential, and provider billing limit. Keep generation disabled until approval; the configured daily maximum is one call including retries. Cloudinary publication requires a separate staging account, staging credentials and verified quota, plus a later explicit publication authorization. Never place real credentials in templates or source control. `scripts/staging/prisma-staging.sh` defaults to read-only status; only the explicit `--apply` path can migrate or seed.

### Owner setup sequence

1. Create the dedicated OS account and log directories; install the Redis config, ACL and unit from `deploy/staging/` with the Redis ACL file mode `0600`. Set a random staging Redis password in both Redis ACL and backend env, then start only the isolated Redis unit and confirm it listens on `127.0.0.1:6380`.
2. Install `/etc/mator/backend-staging.env` from the example, with mode `0600`; configure its dedicated PostgreSQL credentials, staging Redis password, independent JWT keys and separate Cloudinary account. Leave provider/payment/bot integrations unconfigured and keep the pipeline generation/publication flags false.
3. After reviewing the target and script, run `MATOR_STAGING_CONFIRM=mator_staging scripts/staging/create-staging-db.sh --apply` from the approved root session. Build the staging backend from the reviewed commit. Run `scripts/staging/prisma-staging.sh --status`; only for the new staging database, explicitly approve `MATOR_STAGING_CONFIRM=mator_staging scripts/staging/prisma-staging.sh --apply`.
4. As the dedicated backend account, start `pm2 start ecosystem.staging.config.js --only mator-backend-staging`; check its health on loopback. Do not change the production PM2 definition or public reverse proxy. Keep staging access restricted to the owner/test client.
5. Before synthetic test data is retained, arrange an off-host `rclone` destination, import its encryption recipient public key on the VPS, and keep the private key elsewhere. Stop the staging pipeline for a consistent snapshot, then run the image-pipeline backup and isolated restore-verification scripts documented in `docs/vehicle-image-phase3b-deployment.md`. Do not reuse the existing same-host backup as disaster recovery.
6. Insert only synthetic Garage fixtures through the staging application. Run `scripts/staging/vehicle-image-smoke.mjs` using an existing synthetic Garage vehicle ID and staging-only token. This smoke test is read-only and does not create a generation request. Exercise generation/approval/publication only after a separate cost, candidate-review, and Cloudinary-quota approval; the present staging configuration intentionally keeps both flags disabled.

---

## 1. Existing database baseline (one-time)

Run this **once per pre-existing database** (production and any staging/dev DB
that was built with `db push` before migrations were introduced). It tells
Prisma the baseline migration is already reflected in the schema, *without*
executing its SQL.

```bash
# Point at the target DB via DATABASE_URL / DIRECT_URL, then:
npx prisma migrate resolve --applied 20260625093254_init
```

Verify:

```bash
npx prisma migrate status
# Expect: "Database schema is up to date!"
```

After this, the database is under migration control and the standard
[production workflow](#2-production-migration-workflow) applies to all future
changes.

---

## 2. Production migration workflow

**Never** run `migrate dev` or `db push` against production. Production only
ever *applies* migrations that were authored and reviewed in development.

```bash
# 1. Deploy code that contains the new migration(s) under prisma/migrations/
# 2. Apply pending migrations (idempotent; only runs un-applied ones):
npx prisma migrate deploy

# 3. Regenerate the client if it isn't generated during the build:
npx prisma generate
```

Typical release order:

1. `npm ci`
2. `npm run build`
3. `npx prisma migrate deploy`   ← applies schema changes
4. start / restart the app (`npm run start:prod`)

`migrate deploy`:
- applies only migrations not yet in the `_prisma_migrations` table,
- never generates new migrations,
- never prompts,
- exits non-zero on drift or a failed migration (fail the deploy on this).

If a migration fails partway, resolve it explicitly before retrying:

```bash
npx prisma migrate resolve --rolled-back <migration_name>   # mark as rolled back
# fix the migration SQL, redeploy
```

---

## 3. Development migration workflow

When you change [`prisma/schema.prisma`](../prisma/schema.prisma), create a
migration locally against a **dev** database:

```bash
# Generates SQL from the schema diff, applies it to the dev DB, and
# regenerates the Prisma client. Prompts for a migration name.
npx prisma migrate dev --name <short_description>
```

This writes a new folder under `prisma/migrations/` — **commit it** alongside
the schema change. Review the generated SQL before committing, especially for:

- destructive changes (dropped columns/tables, narrowed types),
- non-nullable columns added to populated tables (need a default or a backfill),
- renames (Prisma emits drop+create unless you hand-edit the SQL).

Other useful commands:

```bash
npx prisma migrate status     # what's applied vs pending
npx prisma migrate reset      # DROP + re-apply all migrations + seed (DEV ONLY)
npx prisma generate           # regenerate client without touching the DB
```

`migrate reset` is destructive and must never be pointed at a shared/production
database.

---

## Driver's Village photo limits

The Driver's Village photo path is open to any Telegram user, so these per-sender
limits apply to it. Both are optional environment variables; an unset or invalid
value uses the default. Counters live in Redis. If Redis cannot answer, the bot
refuses and says processing is temporarily unavailable.

| Variable | Default | Meaning |
|---|---|---|
| `DV_PHOTO_ALBUMS_PER_HOUR` | 20 | Albums one sender may send into the path per hour |
| `DV_PHOTO_AMBIGUOUS_PER_HOUR` | 5 | Position lists shown to one sender per hour for an ambiguous code |

Image processing starts only after the sender confirms the resolved position. There
is no daily limit on the number of FLUX jobs.

## Health checks

The app exposes probes (throttle-exempt, no auth):

| Endpoint | Checks | Use for |
|---|---|---|
| `GET /health/live` | Process is up (no DB). | Liveness probe. |
| `GET /health` | `SELECT 1` against Postgres. Returns `503` if the DB is unreachable. | Readiness probe. |

Point your load balancer / orchestrator readiness check at `GET /health` so
instances are pulled from rotation when the database is down.

---

## PM2 process management

[`ecosystem.config.js`](../ecosystem.config.js) runs the app in `fork` mode
with a single instance — **not** cluster mode, because `TelegramService` keeps
in-memory state (media-group upload buffers, the long-polling connection) that
isn't safe to share across multiple worker processes.

It writes stdout/stderr to `./logs/out.log` / `./logs/error.log` (relative to
the project root). That directory is gitignored (`logs/` in
[`.gitignore`](../.gitignore)) since log files are runtime output, not source.
PM2 creates the directory automatically the first time it opens those log
files, but create it explicitly before the first start so the behavior doesn't
depend on the PM2 version:

```bash
mkdir -p logs
```

### PM2 log rotation (pm2-logrotate)

PM2 does not rotate or cap its log files on its own — left unmanaged,
`logs/out.log` / `logs/error.log` grow forever and can fill the disk. Install
the official `pm2-logrotate` module (itself a PM2-managed process, not a
system package) to handle this automatically:

```bash
pm2 install pm2-logrotate

pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```

**What each setting does:**

| Setting | Value | Meaning |
|---|---|---|
| `max_size` | `20M` | Rotate a log file as soon as it reaches 20 MB, regardless of the time-based schedule below. Caps how large any single log file can get between rotations. |
| `retain` | `14` | Keep the 14 most recent rotated log files per stream (out/error); older ones are deleted automatically. At one rotation/day this is roughly two weeks of history. |
| `compress` | `true` | Gzip rotated log files (`.log.gz`) instead of leaving them as plain text, reducing disk usage for retained history. |
| `rotateInterval` | `'0 0 * * *'` | Cron expression for the time-based rotation schedule — minute 0, hour 0, every day: i.e. rotate once daily at midnight (server local time), independent of the size-based trigger. |

Together, a log file rotates whenever it hits 20 MB *or* at midnight, whichever
comes first; up to 14 rotated, gzip-compressed copies are kept per stream, and
anything older is pruned automatically — bounding disk usage without manual
intervention.

Verify the module is running and check current settings at any time:

```bash
pm2 list                      # pm2-logrotate should appear as an online process
pm2 conf pm2-logrotate         # show all pm2-logrotate settings currently in effect
```

### Fresh Ubuntu VPS: full deployment sequence

Run after copying the project and its `.env` (see [Required environment](#required-environment)
and [`.env.example`](../.env.example)) onto the VPS, with Node.js, npm, and PM2
already installed globally:

```bash
# 1. Install dependencies exactly as locked
npm ci

# 2. Compile TypeScript -> dist/
npm run build

# 3. Apply database migrations (uses DIRECT_URL; never `migrate dev`/`db push` here)
npx prisma migrate deploy

# 4. Ensure the PM2 log directory exists (PM2 also creates it on first write)
mkdir -p logs

# 5. Start the app under PM2 using the production env block
pm2 start ecosystem.config.js --env production

# 6. Persist the current process list so PM2 restores it on reboot
pm2 save

# 7. Generate (and follow the printed instructions to install) the OS-level
#    startup script, so PM2 itself restarts after a VPS reboot
pm2 startup

# 8. Install and configure log rotation (one-time; persists across restarts
#    once `pm2 save` has been re-run — see below)
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```

Notes:
- `pm2 startup` prints a `sudo env PATH=... pm2 startup systemd -u <user> --hp <home>`
  command — run that printed command as instructed; it registers PM2 with
  systemd so the process list survives a reboot.
- Re-run `pm2 save` after step 8 if you want `pm2-logrotate` itself to survive
  a reboot as part of the restored process list (it's a PM2-managed process
  like the app itself).
- For subsequent deploys (not the first), repeat steps 1–3 and 5, replacing
  step 5 with `pm2 reload ecosystem.config.js --env production` for a
  zero-downtime restart, or `pm2 restart mator-backend` for a simple restart.

## Maintenance scripts

`backfill:catalog`, `fix:category-slugs`, `seed:category-titles`, `payme:fixture` and
`admin:create` do nothing by default: they print what they would change and a code.

    npm run backfill:catalog                                  # dry run
    npm run backfill:catalog -- --apply --confirm=<code>      # local database

Any database that is not a loopback host outside production also needs its own name,
exactly as the dry run prints it: `--allow-database=<host/db>`. The code covers the
script, the database and the plan, so a plan that changed needs a new dry run.
`admin:create` bootstrapping therefore takes two runs.

## Reverse proxy, client addresses and admin sign-in

Nginx must run on the same machine as the app. `trust proxy` is `loopback`, so only a
loopback peer may state a client address in `X-Forwarded-For`, and Nginx's own entry is
the one believed. Set `TRUST_PROXY` to a comma-separated list of addresses or CIDR
ranges if the proxy moves elsewhere; `true` and hop counts are refused at startup.

Manual steps, none of them in this repository:

1. Keep port 3000 off the network. Set `BIND_HOST=127.0.0.1` and restart, or close the
   port in the firewall. Without this a direct caller cannot spoof an address, but it
   does bypass Nginx and its limits.
2. Set the same `ADMIN_PROXY_SECRET` (32 or more random characters) on the API and on
   the admin panel's server. Generate one with `openssl rand -hex 32`. It is what lets
   the panel, which calls the API from one address for every operator, report each
   operator's real address. Never give it a `NEXT_PUBLIC_` name.

Until the secret is set on both sides, the account lockout still works, but the
per-address limits are off and operators share one throttle bucket.

Admin sign-in failures are counted in Redis. After 5 failures an account, or an account
from one address, is locked for 30 seconds, doubling with each further failure up to 15
minutes; 20 failures from one address lock that address. A refused attempt counts nothing
and cannot extend a lock, and every lock lapses by itself within 15 minutes.

So that a guessing attack cannot shut an operator out, the account lock does not apply to
an address that has signed in to that account in the last 30 days, and any other address
that has not failed there gets two tries, which covers a new device. A correct sign-in
clears the account's and that address's failures and gives back its own count on the
per-address counter. If Redis is down, sign-in answers 503.

The panel signs each login and refresh with `ADMIN_PROXY_SECRET`, binding the address, the
time, the method and the path. An unsigned, altered or stale signature is ignored, and
one seen before is treated as unsigned, so the request counts against its real sender.
The panel takes the address from `X-Real-IP`, which its Nginx block must set from
`$remote_addr` (see the panel's DEPLOY-ADMIN.md). If the secret is missing or shorter
than 32 characters, the API ignores the headers and falls back to the account lock alone.

## OTP sending and verification

These are two separate things.

**Sending.** The only limit is one SMS per phone number per 60 seconds, for first requests
and resends alike, shared by every OTP flow on that number. It is one atomic Redis
`SET NX EX 60` on `otp:cooldown:<digits>`, so it holds across instances. While it runs the
API answers 429 with `Retry-After` and `details.retry_after_seconds`, and no code is
created or replaced. If the SMS cannot be queued the API answers 503, the previous code
stays valid and the phone can retry at once; a queue that only timed out keeps the
cooldown, since the job may still be delivered. With Redis down, requests get a 503.

There is no hourly, daily, global or per-network limit on SMS, and no CAPTCHA. The
endpoints sit under the platform-wide 100 requests per minute per client only.

**Verification.** Five attempts per request and ten per phone per hour, counted
atomically before the code is compared. With Redis down, verification answers 503.

## SMS provider

`SMS_PROVIDER` chooses the provider, with its own credentials as listed in
`.env.example`. Delivery runs on the `sms` queue: three attempts with exponential backoff,
and duplicates of one send collapse on the job id `sms_otp_<requestId>_<sendCount>`. A
retry sends the same code, never a new one.

## Delivery limits

All are environment variables read at startup; restart after a change. Anything missing
or not a positive whole number falls back to the default. If Redis is down the routing
budget refuses with 503 rather than allowing a paid call.

| Variable | Default | Limits |
|---|---|---|
| `DELIVERY_QUOTE_PER_MINUTE` | 20 | Courier quotes per buyer per minute |
| `DELIVERY_MAX_SELLERS_PER_QUOTE` | 8 | Distinct sellers one courier quote may route to |
| `DELIVERY_ROUTING_DAILY_PER_USER` | 100 | Uncached routing calls per buyer per day |

## AI chat

There are no usage, token or per-user limits on the chat. Requests are validated (message
up to 2,000 characters, history up to 10 turns of 2,000 each, 20,000 in all) and sit under
the route's pre-existing 15 requests per minute per client.

## Part-number lookup forms (one-time, after the backend)

Rows written before this version need their canonical form added. Originals stay first
and unchanged, and no products are merged.

    npm run backfill:part-number-search-forms                                  # dry run
    npm run backfill:part-number-search-forms -- --apply --confirm=<digest>    # digest from the dry run

If the data changes between the two runs the digest will not match: dry-run again.

## Read-only checks before deploying

Run these yourself, against production, with a read-only connection. They change nothing.

Parts that inactive categories would hide. Expected: no rows.

```sql
WITH RECURSIVE hidden AS (
  SELECT id FROM part_categories WHERE is_active = false
  UNION
  SELECT c.id FROM part_categories c JOIN hidden h ON c.parent_id = h.id
)
SELECT p.category_id, count(*) AS parts
FROM catalog_parts p JOIN hidden h ON h.id = p.category_id
GROUP BY p.category_id ORDER BY parts DESC;
```

Imported positions claiming stock with a zero count. Expected: zero.

```sql
SELECT count(*) FROM catalog_parts p
JOIN stocks s ON p.id = 'part_stock_' || s.id::text
WHERE s.source_system IS NOT NULL AND p.stock_qty = 0 AND p.in_stock = true;
```

## Known limit: the last unit

There is no stock reservation. Each buyer is checked against the current count, so two
buyers checking out at the same moment can both be accepted for the last unit.

## Connection pooling

The retention job takes `pg_try_advisory_xact_lock` and does its deletes in the same
transaction, so it needs one connection and is compatible with PgBouncer transaction
pooling by design. This has been reviewed in code, not run against a real PgBouncer.

## Image jobs and shutdown

The repository's `kill_timeout` is 5 seconds, while a FLUX poll can run for 240. A
restart therefore interrupts running image jobs. BullMQ re-delivers them, and the hourly
draft sweep fails any image whose job is gone, so a seller is never left waiting.

Recommended production value: `kill_timeout: 30000`. It lets SMS jobs and short image jobs
finish, and stays short enough for a quick restart; longer FLUX polls are recovered as
above. It has not been changed here.

## Dealer inventory sync

`POST /v1/integrations/dealers/sync-inventory` accepts up to 12,501,024 bytes (about
12.5 MB), which is enough for 5,000 rows. The body is read before the API key is checked,
so give this location its own size and connection limits in nginx:

    # in the http block
    limit_conn_zone $binary_remote_addr zone=dealer_sync:10m;

    location = /v1/integrations/dealers/sync-inventory {
        client_max_body_size 13m;
        limit_conn dealer_sync 2;
        # the usual proxy_pass settings
    }

This endpoint is refused for `drivers-village` in every mode (403): its stock comes from
the 1C file through Telegram. For every other dealer, `mode=full` keeps its contract: the
request is the whole warehouse, so a full export must not be split into pages (send pages
with `mode=partial`). It may state `expectedTotal`, the number of rows in the whole
export; when that differs from the length of `items` it answers 400 and changes nothing.

## OTP SMS queue

`OTP_JOB_ENCRYPTION_KEY` (32 bytes, as 64 hex characters or base64) is required in
production, and the process refuses to start without it. Generate it with
`openssl rand -hex 32`. Jobs from before this version carry the code in plaintext and are
retained for up to 7 days: clear the `sms` queue's completed and failed jobs after
deploying.

## Cash and terminal collection

An order placed from this version on goes from "awaiting payment" to processing and
delivery without ever being marked paid by hand. After the buyer has paid and received the
physical receipt, an operator records the money with the "Деньги получены" button on the order page of the admin panel
(`POST /v1/orders/:id/offline-collection`). Until then it counts as received nowhere and
cannot be refunded. Orders already placed keep their old reading. The receipt is issued
outside Mator: its number can be entered, and nothing waits for it.

## Deployment dependencies

- Three migrations are pending from earlier releases:
  `20261108000000_offline_collections`, `20261108000100_stock_projection_pending` and
  `20261109000000_drop_category_fiscal_confirmation`. The new code needs the first two,
  and the old code must not run after the third, so stop the API, run
  `npx prisma migrate deploy`, then start the new build.
- API: `ADMIN_PROXY_SECRET`, `BIND_HOST=127.0.0.1` or a firewall on port 3000, and
  `OTP_JOB_ENCRYPTION_KEY`. Admin server: the same `ADMIN_PROXY_SECRET`.
- The app's order cancel button needs this backend's `POST /v1/orders/:id/cancel`, so the
  backend goes first. Installed apps keep working without the update.
