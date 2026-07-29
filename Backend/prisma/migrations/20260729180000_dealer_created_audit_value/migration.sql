-- Add the DEALER_CREATED audit verb, written when an operator creates a curated
-- dealer/storefront from the console (POST /v1/admin/dealers).
--
-- Kept as an isolated `ALTER TYPE ... ADD VALUE` with no statement that consumes
-- the new value in the same migration: PostgreSQL forbids using a freshly added
-- enum value in the same transaction that adds it. `IF NOT EXISTS` makes re-runs
-- and already-migrated environments a clean no-op.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_CREATED';
