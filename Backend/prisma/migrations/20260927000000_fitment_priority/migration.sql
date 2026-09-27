-- Fitment Studio: manual rank for the part-first digitization queue.
-- NULL = not in the queue (the default for the whole catalogue); 1 = first.
-- Backfilled from sales by prisma/backfill-fitment-priority.ts, then curated by
-- hand, which is why this is a stored column and not a salesCount ORDER BY.
ALTER TABLE "catalog_parts" ADD COLUMN "fitment_priority" INTEGER;

-- The queue reads WHERE fitment_priority IS NOT NULL ORDER BY fitment_priority.
CREATE INDEX "catalog_parts_fitment_priority_idx" ON "catalog_parts"("fitment_priority");
