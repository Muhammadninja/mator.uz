-- Audit actions for the seller ledger: money Mator sends sellers (seller_payouts), and
-- holding an order back from payouts while a cancellation or return is under way.
--
-- On their own, ahead of the migration that uses them, for the reason given in
-- 20260728000000_dealer_audit_enum_values: a value added to an enum cannot be used in the
-- transaction that adds it. IF NOT EXISTS makes a re-run a no-op.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'SELLER_PAYOUT_RECORDED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'SELLER_PAYOUT_VOIDED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ORDER_PAYOUT_HOLD_SET';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'ORDER_PAYOUT_HOLD_RELEASED';
