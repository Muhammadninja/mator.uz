-- Product decision: inventory quantity is not exposed. A product is available
-- because it exists (availability is the `in_stock` boolean, derived from the
-- supply-side stock quantity at projection time); if unavailable it is
-- unpublished or deleted. The `stock_qty` mirror column is unused by any
-- business logic (only written by the projection and echoed by the Buyer API),
-- so it is dropped. `in_stock` is unaffected.

-- AlterTable
ALTER TABLE "catalog_parts" DROP COLUMN "stock_qty";
