-- Where a service line's receipt data comes from. A service has no catalog part, so
-- without these it has no MXIK and no tax id, and an order of services could only be
-- paid with no receipt at all, which is not allowed.
--
-- Additive only, with no backfill: every existing row stays NULL, and a line whose
-- service or provider is NULL is refused at checkout. Nothing here makes anything
-- payable by itself. Must be deployed before the code, which reads these columns.

ALTER TABLE "service_providers"
  ADD COLUMN "tin" VARCHAR(14),
  ADD COLUMN "vat_percent" DECIMAL(5,2);

ALTER TABLE "provider_service_offerings"
  ADD COLUMN "category_id" VARCHAR(64);

CREATE INDEX "provider_service_offerings_category_id_idx"
  ON "provider_service_offerings"("category_id");

ALTER TABLE "provider_service_offerings"
  ADD CONSTRAINT "provider_service_offerings_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "part_categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
