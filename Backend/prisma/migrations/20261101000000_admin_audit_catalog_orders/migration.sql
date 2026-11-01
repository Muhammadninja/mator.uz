-- Extends the admin audit trail from accounts and dealers to the catalog and to
-- orders: category deletes and transfers, part moves, inventory edits, brand and
-- model deletes, payment confirmations, cancellations and admin profile edits.
--
-- Purely additive: only new enum values, so nothing existing is rewritten, no
-- table is locked for longer than the catalog update, and rolling the application
-- back leaves the database valid (the older build simply never writes these).
--
-- Kept free of any statement that USES the values: PostgreSQL restricts
-- `ALTER TYPE ... ADD VALUE` from sharing a transaction with a use of the new value
-- (see 20260728000000_dealer_audit_enum_values). IF NOT EXISTS makes a re-run a
-- clean no-op.
ALTER TYPE "AdminAuditEntity" ADD VALUE IF NOT EXISTS 'CATEGORY';
ALTER TYPE "AdminAuditEntity" ADD VALUE IF NOT EXISTS 'CATALOG_PART';
ALTER TYPE "AdminAuditEntity" ADD VALUE IF NOT EXISTS 'ORDER';
ALTER TYPE "AdminAuditEntity" ADD VALUE IF NOT EXISTS 'BRAND';
ALTER TYPE "AdminAuditEntity" ADD VALUE IF NOT EXISTS 'VEHICLE_MODEL';

ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_DELETED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_ITEMS_TRANSFERRED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CATALOG_PART_MOVED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'INVENTORY_UPDATED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'BRAND_DELETED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'MODEL_DELETED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ORDER_PAYMENT_CONFIRMED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ORDER_CANCELLED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_PROFILE_UPDATED';
