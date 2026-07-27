-- Admin dealer console (/v1/admin/dealers). Purely ADDITIVE: two new enums, new
-- columns on catalog_sellers and admin_audits, and two new indexes. No existing
-- column is altered, renamed or dropped, so GET /v1/dealers keeps returning the
-- exact same payload and the administrator audit trail keeps its current shape.
--
-- Two naming collisions are resolved by ADDING rather than repurposing:
--   • catalog_sellers.orders is a pre-formatted display string ("18k+") that
--     GET /v1/dealers returns. The console needs an integer, so it gets its own
--     orders_count column and `orders` is left untouched.
--   • catalog_sellers.color is the legacy storefront accent, set only on curated
--     rows. brand_color is the console's own field; the backfill below seeds it
--     from `color` so curated dealers render correctly from day one.

-- CreateEnum
CREATE TYPE "DealerStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
-- Target kind for audit entries about something other than an admin account.
CREATE TYPE "AdminAuditEntity" AS ENUM ('DEALER');

-- AlterEnum
-- Dealer moderation verbs. Appending to an enum is backward-compatible: no
-- existing value is renamed or removed, so stored rows keep their meaning.
--
-- Note: ALTER TYPE ... ADD VALUE cannot run inside a transaction block on
-- PostgreSQL < 12. Prisma wraps each migration in one, so this file targets
-- PostgreSQL 12+, where the restriction was lifted for values not used in the
-- same transaction — the same requirement as 20260725120000_draft_committing_status.
-- None of the values added here is referenced later in this file.
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_CERTIFIED_ENABLED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_CERTIFIED_DISABLED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_LOWEST_PRICE_ENABLED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_LOWEST_PRICE_DISABLED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_APPROVED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_SUSPENDED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_REACTIVATED';
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'DEALER_UPDATED';

-- AlterTable
-- Every column is NOT NULL with a DEFAULT, or nullable, so existing rows
-- (curated dealers AND projected seller_<id> rows) are backfilled in place and
-- no insert path anywhere else in the codebase has to change.
--
-- joined_at defaults to CURRENT_TIMESTAMP, which also backfills existing rows:
-- catalog_sellers has never had a creation timestamp, so "now" is the only
-- honest value available. updated_at is maintained by Prisma's @updatedAt.
ALTER TABLE "catalog_sellers" ADD COLUMN     "brand_color" VARCHAR(9),
ADD COLUMN     "certified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "city" VARCHAR(120),
ADD COLUMN     "email" VARCHAR(255),
ADD COLUMN     "phone_e164" VARCHAR(20),
ADD COLUMN     "gmv_uzs" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lowest_price" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "orders_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" "DealerStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "suspended_reason" VARCHAR(500),
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill the curated MATOR-certified dealers (is_curated = true). They are
-- live, human-verified storefronts that predate this console, so landing them
-- as PENDING would wrongly hide them behind an approval queue and un-certify
-- them. Projected seller_<id> rows are deliberately NOT touched: they stay
-- PENDING and uncertified, which is exactly the moderation queue the console
-- exists to work through.
UPDATE "catalog_sellers"
SET "status"      = 'ACTIVE',
    "certified"   = true,
    "brand_color" = "color"
WHERE "is_curated" = true;

-- CreateIndex
CREATE INDEX "catalog_sellers_status_joined_at_idx" ON "catalog_sellers"("status", "joined_at");

-- AlterTable
-- Generic target on the audit trail. target_admin_id is an FK to app_admins and
-- so cannot hold a dealer id; these columns carry the target of any action whose
-- subject is not an administrator account. Deliberately NOT a foreign key: the
-- trail is append-only and must outlive the row it describes.
ALTER TABLE "admin_audits" ADD COLUMN     "target_entity" "AdminAuditEntity",
ADD COLUMN     "target_entity_id" VARCHAR(64),
ADD COLUMN     "previous_values" JSONB,
ADD COLUMN     "new_values" JSONB,
ADD COLUMN     "reason" VARCHAR(500);

-- CreateIndex
CREATE INDEX "admin_audits_target_entity_target_entity_id_created_at_idx" ON "admin_audits"("target_entity", "target_entity_id", "created_at");
