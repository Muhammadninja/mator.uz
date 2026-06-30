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
