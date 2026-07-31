-- Payme integration: make a provider transaction id unique per provider.
--
-- Payme retries and parallelises Merchant API calls, so CreateTransaction can
-- arrive twice with the same `params.id`. The old plain index allowed both
-- racing requests to insert a row, after which `findFirst` picked between
-- duplicate payments non-deterministically. The unique index makes the second
-- insert fail with P2002, which the service catches and turns into the
-- idempotent "transaction already created" response.
--
-- Safe to apply: NULLs are exempt from UNIQUE in PostgreSQL, so invoices created
-- before Payme binds a transaction id (provider_transaction_id IS NULL) are
-- unaffected and may coexist freely. Verified against the live database before
-- writing this migration: payments held 0 rows, 0 non-null transaction ids and
-- 0 duplicate (provider, provider_transaction_id) groups.
--
-- Non-destructive: no column or row is dropped; the redundant single-column
-- index is replaced by the composite unique index that supersedes it for lookups
-- keyed on (provider, provider_transaction_id).

DROP INDEX IF EXISTS "payments_provider_transaction_id_idx";

CREATE UNIQUE INDEX "payments_provider_provider_transaction_id_key"
  ON "payments" ("provider", "provider_transaction_id");

-- Supports GetStatement, which scans one provider's transactions over a
-- create-time window.
CREATE INDEX "payments_provider_provider_create_time_idx"
  ON "payments" ("provider", "provider_create_time");
