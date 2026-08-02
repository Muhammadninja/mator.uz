-- Curated product RATINGS (admin-maintained), on the supply-side product and
-- its buyer-side projection.
--
-- These are NOT user reviews: there is no review subsystem and none is implied
-- by this migration. Operators set the values by hand in the admin console
-- (PATCH /v1/admin/products/:id/rating) and CatalogProjectionService copies them
-- into catalog_parts, exactly as it already copies the motor-oil and category
-- attributes. No table stores an individual review, and no user can write here.
--
-- Purely ADDITIVE and non-destructive: two new columns on each of two existing
-- tables, no column dropped, renamed, retyped, or backfilled from a guess. Every
-- existing row keeps its current meaning, and every current query returns
-- exactly what it returned before.
--
-- rating_avg is NUMERIC(2,1) — one decimal place over the 0.0–5.0 range, so the
-- stored value IS the displayed value and no rounding happens at read time. It
-- is NULLABLE on purpose: NULL means "not rated" (the client renders no stars),
-- which is a genuinely different fact from 0.0 ("rated zero"). Defaulting it to
-- 0 would silently claim every unrated product had been rated the worst
-- possible score.
--
-- review_count is NOT NULL DEFAULT 0 for the mirror-image reason: "no ratings
-- yet" is a known quantity (zero), never unknown, so every row can answer it.
--
-- ── Why no CHECK constraints ──
-- The 0–5 bound is enforced by the DTO (class-validator @Min(0)/@Max(5) on the
-- one admin endpoint that writes it) rather than by a database CHECK. Prisma
-- cannot express a CHECK in schema.prisma, so a hand-written one would be
-- invisible to the schema and every future `prisma migrate dev` / `migrate diff`
-- would report permanent drift — and could offer to DROP it. No other migration
-- in this project uses CHECK constraints, and introducing the first one here
-- would trade a validation rule that already holds for a standing operational
-- hazard.
--
-- The precision half of the contract IS enforced by the database: NUMERIC(2,1)
-- rejects a second decimal place by scale, so 4.75 can never be stored.

-- AlterTable: supply-side source of truth.
ALTER TABLE "products"
  ADD COLUMN "rating_avg" DECIMAL(2,1),
  ADD COLUMN "review_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: buyer-side read projection. Mirrors the source columns verbatim so
-- the catalog can render a rating without joining back to the seller domain.
ALTER TABLE "catalog_parts"
  ADD COLUMN "rating_avg" DECIMAL(2,1),
  ADD COLUMN "review_count" INTEGER NOT NULL DEFAULT 0;
