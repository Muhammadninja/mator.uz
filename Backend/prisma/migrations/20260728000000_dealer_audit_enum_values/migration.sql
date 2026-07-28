-- Repair 1/2 for 20260727000000_add_admin_dealers, which applied only PARTIALLY
-- on production: its catalog_sellers columns landed, but the admin_audits half
-- did not, so every dealer mutation 500s on the audit insert.
--
-- This migration re-asserts ONLY the dealer moderation verbs on AdminAuditAction.
-- It is deliberately kept SEPARATE from any statement that consumes these values
-- (the columns/index live in the next migration): PostgreSQL restricts
-- `ALTER TYPE ... ADD VALUE` from sharing a transaction with a use of the new
-- value, and mixing the two is the most likely reason the original migration did
-- not apply atomically. Isolated here, there is nothing to partially apply.
--
-- Every statement is `IF NOT EXISTS`, so on any environment where the original
-- migration DID fully apply this is a clean no-op — no drift, no duplicate value.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_CERTIFIED_ENABLED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_CERTIFIED_DISABLED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_LOWEST_PRICE_ENABLED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_LOWEST_PRICE_DISABLED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_APPROVED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_SUSPENDED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_REACTIVATED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_UPDATED';
