-- READ-ONLY vehicle catalog report (Wave 1 preparation, 2026-11-12).
--
-- Nothing here writes: the whole file runs inside a READ ONLY transaction that
-- is rolled back. It answers, before any import:
--   • what the reference holds and who depends on each row (Garage vehicles,
--     curated fitment bindings, vehicle-image identities, trims);
--   • which rows already carry year_from / year_to / body_type (image-identity
--     inputs that must stay as they are);
--   • which make/model names parts are listed under that no selectable
--     reference row matches (the dealer-inventory demand signal);
--   • whether anything Wave 1 adds or holds back already exists.
--
-- Visual generation rows (`variant_of_model_id` set, e.g. nexia-1/2/3 → nexia,
-- migration 20261115000000) are hidden from the picker; they are read through
-- to_jsonb so this file runs before and after that migration.
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$READ_ONLY_URL" -X -f scripts/sql/vehicle-catalog-readonly-report.sql \
--     > vehicle-catalog-report.txt
--
-- Output is aggregate counts and catalog names only: no user ids, VINs, plates,
-- phone numbers or administrator emails.
-- Run it from a FILE (psql -f, or \i inside psql). Do not paste it into an
-- interactive prompt: a terminal that pastes carriage returns turns the whole
-- script into one line, and psql then reads it all as the `\set` argument.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

\echo '0. Target and optional tables'
SELECT current_database() AS database, now() AS read_at,
       to_regclass('public.fitment_bindings') IS NOT NULL AS has_fitment_bindings,
       to_regclass('public.vehicle_image_identities') IS NOT NULL AS has_image_identities;
SELECT to_regclass('public.vehicle_image_identities') IS NOT NULL AS has_img \gset

\echo '1. Makes: visibility and dependants'
SELECT mk.id, mk.name, mk.is_active, mk.coming_soon, mk.sort_order,
       (SELECT count(*) FROM vehicle_models m WHERE m.make_id = mk.id) AS models,
       (SELECT count(*) FROM vehicles v WHERE v.make_id = mk.id AND v.deleted_at IS NULL) AS garage_vehicles,
       (SELECT count(*) FROM provider_supported_makes p WHERE p.make_id = mk.id) AS provider_links,
       mk.created_at, mk.updated_at
FROM vehicle_makes mk
ORDER BY mk.sort_order, mk.id;

\echo '2. Models: fields and dependants (edited = updated after creation, likely by the admin console)'
SELECT m.make_id, m.id, m.name, m.sort_order, m.year_from, m.year_to, m.body_type,
       to_jsonb(m) ->> 'variant_of_model_id' AS variant_of,
       (SELECT count(*) FROM vehicle_trims t WHERE t.model_id = m.id) AS trims,
       (SELECT count(*) FROM vehicles v WHERE v.model_id = m.id AND v.deleted_at IS NULL) AS garage_vehicles,
       (SELECT count(*) FROM vehicles v WHERE v.model_id = m.id AND v.deleted_at IS NOT NULL) AS deleted_vehicles,
       (SELECT count(*) FROM fitment_bindings b WHERE b."vehicleModelId" = m.id) AS curated_bindings,
       (m.updated_at > m.created_at + interval '1 second') AS edited,
       m.created_at, m.updated_at
FROM vehicle_models m
ORDER BY m.make_id, m.sort_order, m.id;

\echo '3. Image-identity inputs already set on existing models (never written by the seed; nexia-1/2/3 years come from migration 20261115000000)'
SELECT m.make_id, m.id, m.name, m.year_from, m.year_to, m.body_type,
       to_jsonb(m) ->> 'variant_of_model_id' AS variant_of,
       (SELECT count(*) FROM vehicles v
         WHERE v.model_id = m.id AND v.deleted_at IS NULL
           AND ((m.year_from IS NOT NULL AND v.year < m.year_from)
             OR (m.year_to IS NOT NULL AND v.year > m.year_to))) AS vehicles_outside_range
FROM vehicle_models m
WHERE m.year_from IS NOT NULL OR m.year_to IS NOT NULL OR m.body_type IS NOT NULL
ORDER BY m.make_id, m.id;

\echo '4. body_type values in use (new rows must use: sedan hatchback liftback wagon coupe convertible suv mpv van pickup)'
SELECT body_type, count(*) AS models
FROM vehicle_models
WHERE body_type IS NOT NULL
GROUP BY body_type
ORDER BY models DESC, body_type;

\echo '5. Same model name twice within one make (Garage image identity sends these to review)'
SELECT make_id, lower(btrim(name)) AS name_key, string_agg(id, ', ' ORDER BY id) AS ids
FROM vehicle_models
GROUP BY make_id, lower(btrim(name))
HAVING count(*) > 1
ORDER BY make_id, name_key;

\echo '6. Same model name under several makes (ids are one global key space)'
SELECT lower(btrim(name)) AS name_key, string_agg(make_id || '/' || id, ', ' ORDER BY make_id) AS rows
FROM vehicle_models
GROUP BY lower(btrim(name))
HAVING count(DISTINCT make_id) > 1
ORDER BY name_key;

\echo '7. Wave 1 preflight: rows that already exist for what Wave 1 adds or holds back (expect none)'
SELECT 'model' AS kind, m.make_id, m.id, m.name
FROM vehicle_models m
WHERE m.id IN ('suburban', 'chevrolet-suburban')
   OR lower(btrim(m.name)) IN ('suburban', 'equinox phev activ', 'equinox phev', 'damas move',
        'damas max', 'damas move & max', 'passat pro', 'tiguan l pro', 'tiguan l',
        'teramont pro', 'teramont x')
UNION ALL
SELECT 'make', mk.id, mk.id, mk.name
FROM vehicle_makes mk
WHERE lower(btrim(mk.name)) IN ('jetta') OR mk.id IN ('jetta', 'gmc')
ORDER BY 1, 2, 3;

\echo '8. Legacy per-model fitment (catalog_part_fits) by name, against the reference'
WITH fits AS (
  SELECT f.make_name, f.model_name,
         count(DISTINCT f.part_id) AS parts,
         count(DISTINCT f.part_id) FILTER (
           WHERE p.images <> '{}' AND p.price_uzs > 0 AND s.status <> 'SUSPENDED'
         ) AS buyer_listed_parts
  FROM catalog_part_fits f
  JOIN catalog_parts p ON p.id = f.part_id
  JOIN catalog_sellers s ON s.id = p.seller_id
  GROUP BY f.make_name, f.model_name
)
SELECT fits.make_name, fits.model_name, fits.parts, fits.buyer_listed_parts,
       CASE
         WHEN m.id IS NULL AND mk.id IS NULL THEN 'no reference make'
         WHEN m.id IS NULL THEN 'no reference model'
         WHEN to_jsonb(m) ->> 'variant_of_model_id' IS NOT NULL
           THEN 'generation row, hidden (pick ' || (to_jsonb(m) ->> 'variant_of_model_id') || ')'
         WHEN NOT mk.is_active THEN 'model exists, make inactive'
         WHEN mk.coming_soon THEN 'model exists, make coming soon'
         ELSE 'selectable'
       END AS garage_status,
       m.id AS reference_model_id
FROM fits
LEFT JOIN vehicle_makes mk ON lower(btrim(mk.name)) = lower(btrim(fits.make_name))
LEFT JOIN vehicle_models m ON m.make_id = mk.id AND lower(btrim(m.name)) = lower(btrim(fits.model_name))
ORDER BY coalesce(m.id IS NOT NULL AND mk.is_active AND NOT mk.coming_soon
                  AND to_jsonb(m) ->> 'variant_of_model_id' IS NULL, false),
         fits.parts DESC, 1, 2;

\echo '9. Legacy make-wide fitment (catalog_part_make_fits), against the reference'
SELECT f.make_name, count(DISTINCT f.part_id) AS parts,
       CASE WHEN mk.id IS NULL THEN 'no reference make'
            WHEN NOT mk.is_active THEN 'make inactive'
            WHEN mk.coming_soon THEN 'make coming soon'
            ELSE 'selectable' END AS garage_status
FROM catalog_part_make_fits f
LEFT JOIN vehicle_makes mk ON lower(btrim(mk.name)) = lower(btrim(f.make_name))
GROUP BY f.make_name, mk.id, mk.is_active, mk.coming_soon
ORDER BY parts DESC, f.make_name;

\echo '10. Supply side (seller bot / dealer import: part_models, part_makes), against the reference'
WITH supply AS (
  SELECT b.name AS make_name, cm.name AS model_name, count(DISTINCT pm.part_id) AS products
  FROM part_models pm
  JOIN car_models cm ON cm.id = pm.model_id
  JOIN brands b ON b.id = cm.brand_id
  GROUP BY b.name, cm.name
  UNION ALL
  SELECT b.name, NULL, count(DISTINCT pk.part_id)
  FROM part_makes pk
  JOIN brands b ON b.id = pk.brand_id
  GROUP BY b.name
)
SELECT supply.make_name, coalesce(supply.model_name, '(whole make)') AS model_name, supply.products,
       CASE
         WHEN mk.id IS NULL THEN 'no reference make'
         WHEN supply.model_name IS NOT NULL AND m.id IS NULL THEN 'no reference model'
         WHEN to_jsonb(m) ->> 'variant_of_model_id' IS NOT NULL
           THEN 'generation row, hidden (pick ' || (to_jsonb(m) ->> 'variant_of_model_id') || ')'
         WHEN NOT mk.is_active THEN 'make inactive'
         WHEN mk.coming_soon THEN 'make coming soon'
         ELSE 'selectable'
       END AS garage_status
FROM supply
LEFT JOIN vehicle_makes mk ON lower(btrim(mk.name)) = lower(btrim(supply.make_name))
LEFT JOIN vehicle_models m ON m.make_id = mk.id AND lower(btrim(m.name)) = lower(btrim(supply.model_name))
ORDER BY supply.products DESC, 1, 2;

\echo '10b. Visual generation rows and the Garage vehicles that picked one'
SELECT m.make_id, to_jsonb(m) ->> 'variant_of_model_id' AS variant_of, m.id, m.name,
       m.year_from, m.year_to, m.sort_order,
       (SELECT count(*) FROM vehicles v
         WHERE to_jsonb(v) ->> 'variant_model_id' = m.id AND v.deleted_at IS NULL) AS picked_by_vehicles,
       (SELECT count(*) FROM vehicles v WHERE v.model_id = m.id AND v.deleted_at IS NULL) AS vehicles_with_it_as_model
FROM vehicle_models m
WHERE to_jsonb(m) ->> 'variant_of_model_id' IS NOT NULL
ORDER BY 2, m.year_from NULLS LAST, m.id;

\echo '11. Curated fitment bindings per make (must survive every import)'
SELECT m.make_id, mk.is_active, count(*) AS bindings, count(DISTINCT b."partId") AS parts,
       count(DISTINCT b."vehicleModelId") AS models
FROM fitment_bindings b
JOIN vehicle_models m ON m.id = b."vehicleModelId"
JOIN vehicle_makes mk ON mk.id = m.make_id
GROUP BY m.make_id, mk.is_active
ORDER BY bindings DESC;

\echo '12. Garage vehicles by make visibility (inactive/coming-soon makes still referenced)'
SELECT mk.id AS make_id, mk.is_active, mk.coming_soon, count(v.id) AS garage_vehicles,
       count(v.id) FILTER (WHERE v.trim_id IS NOT NULL) AS with_trim
FROM vehicle_makes mk
JOIN vehicles v ON v.make_id = mk.id AND v.deleted_at IS NULL
GROUP BY mk.id, mk.is_active, mk.coming_soon
ORDER BY garage_vehicles DESC;

\echo '13. Reference makes/models deleted through the admin console (ids and dates only)'
SELECT a.action, a.target_entity, a.target_entity_id, a.created_at
FROM admin_audits a
WHERE a.action::text IN ('BRAND_DELETED', 'MODEL_DELETED')
ORDER BY a.created_at;

\if :has_img
\echo '14. Vehicle-image identities by status, and the body types they were hashed with'
SELECT status, count(*) AS identities FROM vehicle_image_identities GROUP BY status ORDER BY status;
SELECT identity->>'makeId' AS make_id, identity->>'modelId' AS model_id,
       coalesce(identity->>'bodyType', '(null)') AS body_type, count(*) AS identities,
       count(*) FILTER (WHERE status = 'APPROVED') AS approved
FROM vehicle_image_identities
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
\echo '14b. Identity body type that differs from the model row now (a later edit split the key)'
SELECT i.identity->>'modelId' AS model_id, i.identity->>'bodyType' AS identity_body_type,
       m.body_type AS model_body_type, count(*) AS identities
FROM vehicle_image_identities i
LEFT JOIN vehicle_models m ON m.id = i.identity->>'modelId'
WHERE (i.identity->>'bodyType') IS DISTINCT FROM nullif(btrim(m.body_type), '')
GROUP BY 1, 2, 3
ORDER BY 1;
\echo '14c. Garage vehicles flagged for image review, by reason'
SELECT image_review_reason, count(*) AS vehicles FROM vehicles
WHERE image_review_reason IS NOT NULL AND deleted_at IS NULL
GROUP BY image_review_reason ORDER BY vehicles DESC;
\else
\echo '14. vehicle_image_identities does not exist here (Phase 3E migration not applied); skipped'
\endif

ROLLBACK;
