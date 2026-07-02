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

Prisma reads `directUrl` from the datasource block for migration commands, so no
extra flag is needed as long as `DIRECT_URL` is set.

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
