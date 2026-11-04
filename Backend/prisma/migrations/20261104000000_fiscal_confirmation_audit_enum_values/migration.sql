-- Audit values for two operator acts that decide what reaches a tax receipt:
-- confirming a category's fiscal codes against Tasnif, and classifying a sourcing
-- offer so it can be fiscalized.
--
-- Purely additive: only new enum values, so nothing existing is rewritten and
-- rolling the application back leaves the database valid (the older build simply
-- never writes these).
--
-- A file of its own, free of any statement that USES the values: PostgreSQL
-- restricts `ALTER TYPE ... ADD VALUE` from sharing a transaction with a use of the
-- new value (see 20260728000000_dealer_audit_enum_values). IF NOT EXISTS makes a
-- re-run a clean no-op.
ALTER TYPE "AdminAuditEntity" ADD VALUE IF NOT EXISTS 'SOURCING_OFFER';

ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_FISCAL_CONFIRMED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_FISCAL_UNCONFIRMED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'SOURCING_OFFER_CLASSIFIED';
