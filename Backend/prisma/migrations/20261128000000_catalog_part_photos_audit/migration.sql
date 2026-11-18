-- Audit action for editing a part's photo gallery from the admin photo-coverage console.
--
-- On its own, for the reason given in 20260728000000_dealer_audit_enum_values: a value
-- added to an enum cannot be used in the transaction that adds it. IF NOT EXISTS makes a
-- re-run a no-op.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CATALOG_PART_PHOTOS_UPDATED';
