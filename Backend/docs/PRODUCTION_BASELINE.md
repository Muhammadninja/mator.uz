# Production Baseline Migration

**Status:** NOT YET PERFORMED on production. Do this **once**, right before the
Phase 2–4 release — not now. Running it earlier just means running it again later.

This document explains how to move the **existing production database** from its
current `db push`-managed state onto the new single baseline migration
(`00000000000000_init_baseline`) **without data loss and without downtime beyond
a normal deploy**.

New / empty databases do **not** need any of this — for them
`prisma migrate deploy` + `npm run seed` already works (proven in Phase 1). This
document is *only* for the one production database that predates the baseline.

---

## 1. Why production is in "drift"

Prisma tracks applied migrations in a table called `_prisma_migrations`. A
database is considered **in sync** when the set of migration folders in
`prisma/migrations/` matches the set of rows in `_prisma_migrations`.

Historically this project's schema was evolved with `prisma db push` (which
mutates the database directly and writes **no** migration record) mixed with a
handful of hand-written migrations. The result, before Phase 1:

- The production `_prisma_migrations` table contains **13 old rows**
  (`20260603115310_init` … `20260715000000_add_oem_compatibility_and_part_number_type`).
- Most buyer-side tables (`catalog_parts`, `vehicle_makes`, `orders` in its
  current form, `payments`, `service_providers`, `ai_*`, `notifications`, …)
  were created by `db push`, so **no migration file ever created them**.
- Two of the old migrations (`20260711230000`, `20260715000000`) only `ALTER`
  `catalog_parts` — a table nothing in the migration history creates.

In Phase 1 those 13 migrations were **archived** to
`prisma/_migrations_archive_pre_baseline/` and replaced by a single
`00000000000000_init_baseline` migration generated directly from
`schema.prisma` (50 tables + 27 enums, byte-identical to the schema).

So now there is a **mismatch on production**:

| Location | Contents |
|----------|----------|
| `prisma/migrations/` (git) | just `00000000000000_init_baseline` |
| production `_prisma_migrations` table | 13 old rows, none of which exist as folders anymore |

That mismatch is the "drift" Prisma will complain about.

---

## 2. Why you cannot just run `prisma migrate deploy`

On production, `prisma migrate deploy` will:

1. See 13 applied migrations in `_prisma_migrations` that **no longer exist** in
   `prisma/migrations/` → it reports **failed / drifted state** and refuses to
   proceed cleanly.
2. Even if it did proceed, it would try to **apply
   `00000000000000_init_baseline`**, whose first statements are
   `CREATE TABLE "app_users"`, `CREATE TABLE "catalog_parts"`, etc. Those tables
   **already exist** on production → every `CREATE TABLE` throws
   `relation already exists` and the migration fails halfway, leaving a
   `failed` row behind.

The baseline migration is correct for an **empty** database. On the **existing**
database the tables are already there, so the baseline must be **recorded as
already-applied**, not executed. That is what the steps below do.

---

## 3. How to safely move production onto the baseline

The safe path is Prisma's official ["baselining"](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining)
workflow: tell Prisma "this baseline migration is already applied" instead of
running it.

> ⚠️ Every command below writes to the **production** `_prisma_migrations`
> bookkeeping table. **None of them touch your actual data or your 50 real
> tables** — they only reconcile Prisma's migration ledger. Still: **take a
> backup first** (Neon branch or `pg_dump`).

### Preconditions
- The production schema currently matches `schema.prisma` (it does — that's what
  `db push` kept it at). If unsure, verify with step 5.1 **before** touching the
  ledger.
- You are pointing at production. Confirm the host in `DATABASE_URL` /
  `DIRECT_URL` is the production instance (`ep-rapid-night-apb7sf06…`,
  database `neondb`) and **not** the Phase-1 test database.

---

## 4. Commands to run (in order)

All commands run from `Backend/`. They use the production `DATABASE_URL` /
`DIRECT_URL` from your production environment — do **not** hard-code the
connection string in a file.

### 4.0 — Back up first (mandatory)
Create a Neon branch (instant, recommended) **or** a logical dump:
```bash
# Neon: create a branch from the current production state as a restore point
#   (via the Neon console or CLI) — this is the fastest rollback path.

# OR a logical dump:
pg_dump "$DATABASE_URL" --no-owner --format=custom --file=prod_pre_baseline.dump
```

### 4.1 — Drop the 13 stale ledger rows
These rows reference migrations that no longer exist as folders. Removing them
clears the drift. This only edits Prisma's bookkeeping table:
```sql
-- Run against production (psql, Neon SQL editor, etc.)
DELETE FROM "_prisma_migrations"
WHERE migration_name IN (
  '20260603115310_init',
  '20260604103355_add_user_and_garage',
  '20260604120000_brand_model_architecture',
  '20260605122209_add_app_user_auth',
  '20260605163453_add_role_to_app_user',
  '20260605191102_add_seller_status',
  '20260605191453_link_usercar_to_appuser',
  '20260610082934_convert_refresh_token_to_hash',
  '20260625133853_add_user_language',
  '20260625190600_add_product_images',
  '20260711230000_add_part_classification_and_fits',
  '20260712000000_add_japan_origin_region',
  '20260715000000_add_oem_compatibility_and_part_number_type'
);
```
> If `_prisma_migrations` turns out to hold rows you don't recognize, **stop**
> and inspect (`SELECT migration_name, finished_at FROM "_prisma_migrations";`)
> before deleting anything.

### 4.2 — Record the baseline as already-applied
This inserts a single `_prisma_migrations` row marking the baseline as applied
**without executing its SQL** (so it will not try to re-create existing tables):
```bash
npx prisma migrate resolve --applied 00000000000000_init_baseline
```

### 4.3 — Confirm a clean state
```bash
npx prisma migrate status
```
Expected: `Database schema is up to date!` with exactly **one** migration
(`00000000000000_init_baseline`) listed as applied and **no** drift warning.

---

## 5. How to verify the result

### 5.1 — Schema still matches (no accidental change)
This is a **read-only** check — it reports what `migrate deploy` *would* do:
```bash
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```
Expected output: `-- This is an empty migration.` (i.e. the live database and
`schema.prisma` are identical — nothing to change).

### 5.2 — Ledger is clean
```sql
SELECT migration_name, finished_at IS NOT NULL AS applied
FROM "_prisma_migrations" ORDER BY started_at;
```
Expected: exactly one row — `00000000000000_init_baseline`, `applied = true`.

### 5.3 — A fresh deploy is a no-op
```bash
npx prisma migrate deploy
```
Expected: `No pending migrations to apply.` (does nothing, succeeds).

### 5.4 — App still boots and serves
Start the backend against production (or a Neon branch of it) and hit the core
flows — same smoke test used in Phase 1:
```
GET  /health                 -> 200 {"status":"ok","database":"up"}
GET  /v1/categories?scope=main -> 200 (12 tiles)
GET  /v1/catalog/parts       -> 200
POST /v1/search              -> 200
GET  /v1/garage/vehicles     -> 401 (auth guard alive, DB layer alive)
```

---

## 6. If something goes wrong

**Symptom: `migrate resolve` says the migration is already recorded / applied.**
Harmless — it means the row already exists. Re-run `prisma migrate status` to
confirm the clean single-row state.

**Symptom: `migrate status` still reports drift after step 4.2.**
There are extra rows in `_prisma_migrations` you didn't delete. Inspect with the
query in 5.2 and remove any leftover pre-baseline rows (only ones matching the
13 archived names / anything not `00000000000000_init_baseline`).

**Symptom: `migrate diff` in 5.1 is NOT empty.**
The live schema drifted from `schema.prisma` in some way (e.g. the stray `parts`
table — see below, or a `db push` change never reflected in the schema). **Do
not** run `migrate deploy`. Investigate the diff first; decide per-object whether
the schema or the database is authoritative. Do not proceed to seed/release until
this is empty.

**Symptom: baseline got partially executed and left a `failed` row.**
This happens only if someone ran `migrate deploy` instead of `migrate resolve`.
Fix: `npx prisma migrate resolve --rolled-back 00000000000000_init_baseline`,
verify no tables were dropped/duplicated, then redo from step 4.1.

**Full rollback:** restore the Neon branch / `pg_dump` from step 4.0. Because
steps 4.1–4.2 only touch `_prisma_migrations`, a rollback of just that table
(or restoring the pre-baseline branch) returns you to the exact prior state.

**A note on the stray `parts` table:** production contains a table named `parts`
that is **not** in `schema.prisma` and **not** in the baseline. It is unrelated
to the baseline and is left untouched by this procedure. Investigate/drop it
separately if desired — it is not required for the app to run.

---

## 7. After a successful transition — remove the archive

Once **all** of the following are true on production:
- `prisma migrate status` → up to date, single baseline row (5.2/5.3),
- `migrate diff` in 5.1 is empty,
- the app boots and the smoke test passes (5.4),

…the archived pre-baseline migrations are no longer needed for reference and can
be deleted:
```bash
git rm -r Backend/prisma/_migrations_archive_pre_baseline
git commit -m "Remove pre-baseline migration archive after production baseline"
```
Keep this `PRODUCTION_BASELINE.md` document even after deleting the archive — it
records *why* history was reset, which is useful when onboarding a developer or
migrating the database again.
