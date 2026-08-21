-- OEM / GM article search acceleration.
--
-- `catalog_parts.oem_numbers` and `catalog_parts.gm_numbers` are text[] columns.
-- Article search matches with Prisma `{ has: <normalized> }`, which compiles to
-- the PostgreSQL array-contains operator (`@>`). Without a GIN index that is a
-- sequential scan on every listing; a GIN index on the array makes it an index
-- lookup and also accelerates `hasSome` (`&&`).
--
-- IF NOT EXISTS keeps this idempotent (safe to re-apply). The launch table is
-- tiny, so a plain (non-CONCURRENT) CREATE INDEX is instant and transaction-safe;
-- switch to CREATE INDEX CONCURRENTLY (outside a migration transaction) only if
-- this is ever added to an already-large, write-hot table.

CREATE INDEX IF NOT EXISTS "idx_catalog_parts_oem_numbers_gin"
  ON "catalog_parts" USING GIN ("oem_numbers");

CREATE INDEX IF NOT EXISTS "idx_catalog_parts_gm_numbers_gin"
  ON "catalog_parts" USING GIN ("gm_numbers");
