-- Product decision: Top Featured is removed from the product entirely. The
-- FeaturedItem model, its API, seed, and constants are gone; this drops the
-- backing table. No FK references it (part_id was a plain nullable string, not a
-- relation), so the drop is self-contained.

-- DropTable
DROP TABLE "featured_items";
