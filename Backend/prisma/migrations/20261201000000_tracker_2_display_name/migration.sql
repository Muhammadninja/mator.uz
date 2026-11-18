-- Show Chevrolet `tracker-2` as "Tracker 2" (owner request 2026-11-18). Both
-- Tracker rows were named "Tracker", so the Garage picker listed two identical
-- "Tracker" entries. Only the display name changes: ids, years, trims and
-- bindings stay, and the two still share parts.
--
-- Legacy fit rows keep the name "Tracker" for both cars, so a vehicle or filter
-- naming "Tracker 2" also reads them (LEGACY_FIT_NAME_ALIASES in
-- src/catalog/compatibility/vehicle-fitment.ts).
--
-- Deploy order: deploy the code with that alias BEFORE applying this migration;
-- without it, Tracker 2 owners stop seeing the "Tracker" parts. Then delete the
-- Redis key cache:reference:models:chevrolet (or wait out its 24h TTL).
--
-- Only renames the row while it still has the old name; an operator's own
-- rename is kept.
UPDATE "vehicle_models"
SET "name" = 'Tracker 2', "updated_at" = NOW()
WHERE "id" = 'tracker-2'
  AND "make_id" = 'chevrolet'
  AND "variant_of_model_id" IS NULL
  AND "name" = 'Tracker';
