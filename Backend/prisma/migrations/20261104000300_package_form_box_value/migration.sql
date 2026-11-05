-- A third way of selling a listing: a consumer box («потребительская коробка»).
--
-- Purely additive: one new enum value, nothing rewritten. Rolling the application back
-- is safe until a row holds the value: an older Prisma client cannot read that row.
--
-- A file of its own, free of any statement that USES the value: PostgreSQL restricts
-- `ALTER TYPE ... ADD VALUE` from sharing a transaction with a use of the new value (see
-- 20260728000000_dealer_audit_enum_values). IF NOT EXISTS makes a re-run a clean no-op.
ALTER TYPE "PackageForm" ADD VALUE IF NOT EXISTS 'BOX';
