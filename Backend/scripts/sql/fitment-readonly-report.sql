-- READ-ONLY buyer fitment data-quality report (Wave 3, 2026-11-13).
--
-- Nothing here writes: the whole file runs inside a READ ONLY transaction that
-- is rolled back. It audits the data the ONE buyer decision path reads
-- (src/catalog/compatibility/vehicle-fitment.ts):
--   fitment_bindings      curated, operator-written, matched on model id;
--   catalog_part_fits     legacy per-model rows, matched on make+model NAME;
--   catalog_part_make_fits legacy make-wide rows;
--   part_compatibilities  trim/engine rows;
--   catalog_parts.is_universal, oem_numbers, gm_numbers.
-- Every list is capped (LIMIT) and names catalog parts only: no customer data.
--
-- Run it from a FILE (stdin or -f). Do not paste it into an interactive prompt.
--   sudo -u postgres env PGOPTIONS='-c default_transaction_read_only=on' \
--     psql -X -d mator < Backend/scripts/sql/fitment-readonly-report.sql \
--     > /tmp/fitment-report.txt 2>&1
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';

-- "buyer_listed" columns use the catalog's own rule (buyer-visibility.ts
-- BUYER_LISTED_PART): a ready photo, a price above 0, a seller not suspended.
-- (Inline subqueries, because a READ ONLY transaction refuses CREATE, even TEMP.)

\echo '1. Fitment sources per part (a part can have several)'
SELECT count(*) AS parts,
       count(*) FILTER (WHERE p.is_universal) AS universal,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM fitment_bindings b WHERE b."partId" = p.id)) AS curated,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM catalog_part_fits f WHERE f.part_id = p.id)) AS legacy_per_model,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM catalog_part_make_fits f WHERE f.part_id = p.id)) AS legacy_make_wide,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM part_compatibilities c WHERE c.part_id = p.id)) AS trim_or_engine_rows,
       count(*) FILTER (WHERE p.id IN (SELECT lp.id FROM catalog_parts lp JOIN catalog_sellers ls ON ls.id = lp.seller_id WHERE lp.images <> '{}' AND lp.price_uzs > 0 AND ls.status <> 'SUSPENDED')) AS buyer_listed
FROM catalog_parts p;

\echo '2. Parts with NO vehicle compatibility at all (never shown for a selected vehicle), by category'
SELECT p.category_id, count(*) AS parts,
       count(*) FILTER (WHERE p.id IN (SELECT lp.id FROM catalog_parts lp JOIN catalog_sellers ls ON ls.id = lp.seller_id WHERE lp.images <> '{}' AND lp.price_uzs > 0 AND ls.status <> 'SUSPENDED')) AS buyer_listed
FROM catalog_parts p
WHERE NOT p.is_universal
  AND NOT EXISTS (SELECT 1 FROM fitment_bindings b WHERE b."partId" = p.id)
  AND NOT EXISTS (SELECT 1 FROM catalog_part_fits f WHERE f.part_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM catalog_part_make_fits f WHERE f.part_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM part_compatibilities c WHERE c.part_id = p.id)
GROUP BY p.category_id
ORDER BY parts DESC
LIMIT 50;

\echo '3. Duplicate legacy rows: one part, same make+model name twice (case/space variants)'
SELECT f.part_id, lower(btrim(f.make_name)) AS make, lower(btrim(f.model_name)) AS model,
       string_agg(f.model_slug, ', ') AS slugs
FROM catalog_part_fits f
GROUP BY f.part_id, lower(btrim(f.make_name)), lower(btrim(f.model_name))
HAVING count(*) > 1
LIMIT 50;

\echo '4. One part bound to the same model at several 3D nodes (allowed; listed for review)'
SELECT b."partId" AS part_id, b."vehicleModelId" AS model_id, count(*) AS nodes
FROM fitment_bindings b
GROUP BY 1, 2
HAVING count(*) > 1
ORDER BY nodes DESC
LIMIT 50;

\echo '5. Duplicate trim/engine rows (same part, trim, engine)'
SELECT part_id, trim_id, engine_id, count(*) AS rows, string_agg(DISTINCT status::text, ',') AS statuses
FROM part_compatibilities
GROUP BY part_id, trim_id, engine_id
HAVING count(*) > 1
LIMIT 50;

\echo '6. Trim/engine rows that can match nothing (no trim and no engine, or the trim/engine is gone)'
SELECT c.id, c.part_id, c.trim_id, c.engine_id, c.status
FROM part_compatibilities c
WHERE (c.trim_id IS NULL AND c.engine_id IS NULL)
   OR (c.trim_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vehicle_trims t WHERE t.id = c.trim_id))
   OR (c.engine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vehicle_engines e WHERE e.id = c.engine_id))
LIMIT 50;

\echo '7. Legacy per-model names with no reference model at all (no Garage vehicle can ever match them)'
SELECT f.make_name, f.model_name, count(DISTINCT f.part_id) AS parts,
       count(DISTINCT f.part_id) FILTER (WHERE f.part_id IN (SELECT lp.id FROM catalog_parts lp JOIN catalog_sellers ls ON ls.id = lp.seller_id WHERE lp.images <> '{}' AND lp.price_uzs > 0 AND ls.status <> 'SUSPENDED')) AS buyer_listed
FROM catalog_part_fits f
LEFT JOIN vehicle_makes mk ON lower(btrim(mk.name)) = lower(btrim(f.make_name))
LEFT JOIN vehicle_models m ON m.make_id = mk.id AND lower(btrim(m.name)) = lower(btrim(f.model_name))
WHERE m.id IS NULL
GROUP BY f.make_name, f.model_name
ORDER BY parts DESC;

\echo '8. Compatibility pointing at hidden generation rows or inactive makes'
SELECT 'curated binding' AS source, m.make_id, m.id AS model_id,
       CASE WHEN to_jsonb(m) ->> 'variant_of_model_id' IS NOT NULL
            THEN 'generation row of ' || (to_jsonb(m) ->> 'variant_of_model_id')
            ELSE 'make inactive' END AS why,
       count(DISTINCT b."partId") AS parts
FROM fitment_bindings b
JOIN vehicle_models m ON m.id = b."vehicleModelId"
JOIN vehicle_makes mk ON mk.id = m.make_id
WHERE to_jsonb(m) ->> 'variant_of_model_id' IS NOT NULL OR NOT mk.is_active
GROUP BY m.make_id, m.id, why
UNION ALL
SELECT 'legacy name', m.make_id, m.id,
       CASE WHEN to_jsonb(m) ->> 'variant_of_model_id' IS NOT NULL
            THEN 'generation row of ' || (to_jsonb(m) ->> 'variant_of_model_id')
            ELSE 'make inactive' END,
       count(DISTINCT f.part_id)
FROM catalog_part_fits f
JOIN vehicle_makes mk ON lower(btrim(mk.name)) = lower(btrim(f.make_name))
JOIN vehicle_models m ON m.make_id = mk.id AND lower(btrim(m.name)) = lower(btrim(f.model_name))
WHERE to_jsonb(m) ->> 'variant_of_model_id' IS NOT NULL OR NOT mk.is_active
GROUP BY m.make_id, m.id, 4
ORDER BY 5 DESC;

\echo '9. Curated vs legacy conflicts: curated parts whose legacy rows name a model the bindings leave out (legacy is ignored for these parts)'
SELECT b_set.part_id, b_set.curated_models, f.make_name, f.model_name
FROM (
  SELECT b."partId" AS part_id, array_agg(DISTINCT m.name ORDER BY m.name) AS curated_models,
         array_agg(DISTINCT lower(m.name)) AS keys
  FROM fitment_bindings b JOIN vehicle_models m ON m.id = b."vehicleModelId"
  GROUP BY b."partId"
) b_set
JOIN catalog_part_fits f ON f.part_id = b_set.part_id
WHERE NOT lower(btrim(f.model_name)) = ANY (b_set.keys)
ORDER BY b_set.part_id
LIMIT 100;

\echo '10. Suspiciously broad compatibility (review, not proof of error)'
SELECT 'legacy: many models' AS signal, f.part_id, count(DISTINCT lower(f.model_name)) AS models,
       count(DISTINCT lower(f.make_name)) AS makes
FROM catalog_part_fits f GROUP BY f.part_id HAVING count(DISTINCT lower(f.model_name)) >= 8
UNION ALL
SELECT 'legacy: several makes', f.part_id, count(DISTINCT lower(f.model_name)), count(DISTINCT lower(f.make_name))
FROM catalog_part_fits f GROUP BY f.part_id HAVING count(DISTINCT lower(f.make_name)) >= 2
UNION ALL
SELECT 'curated: many models', b."partId", count(DISTINCT b."vehicleModelId"), NULL
FROM fitment_bindings b GROUP BY b."partId" HAVING count(DISTINCT b."vehicleModelId") >= 8
UNION ALL
SELECT 'make-wide AND per-model rows', p.id, NULL, NULL
FROM catalog_parts p
WHERE EXISTS (SELECT 1 FROM catalog_part_make_fits mf WHERE mf.part_id = p.id)
  AND EXISTS (SELECT 1 FROM catalog_part_fits f WHERE f.part_id = p.id)
ORDER BY 1, 3 DESC NULLS LAST
LIMIT 100;

\echo '11. Universal parts that also carry model fitment (universal wins; the rows are dead)'
SELECT p.id, p.category_id,
       (SELECT count(*) FROM fitment_bindings b WHERE b."partId" = p.id) AS bindings,
       (SELECT count(*) FROM catalog_part_fits f WHERE f.part_id = p.id) AS legacy_rows
FROM catalog_parts p
WHERE p.is_universal
  AND (EXISTS (SELECT 1 FROM fitment_bindings b WHERE b."partId" = p.id)
    OR EXISTS (SELECT 1 FROM catalog_part_fits f WHERE f.part_id = p.id))
LIMIT 50;

\echo '12. Part numbers: missing, or stored without their canonical search form (exact-number search misses them)'
SELECT count(*) FILTER (WHERE cardinality(p.oem_numbers) = 0 AND cardinality(p.gm_numbers) = 0) AS no_numbers,
       count(*) FILTER (WHERE cardinality(p.oem_numbers) = 0 AND cardinality(p.gm_numbers) = 0
                          AND p.id IN (SELECT lp.id FROM catalog_parts lp JOIN catalog_sellers ls ON ls.id = lp.seller_id WHERE lp.images <> '{}' AND lp.price_uzs > 0 AND ls.status <> 'SUSPENDED')) AS no_numbers_buyer_listed
FROM catalog_parts p;
WITH nums AS (
  SELECT p.id AS part_id, 'oem' AS field, n, p.oem_numbers AS arr FROM catalog_parts p, unnest(p.oem_numbers) n
  UNION ALL
  SELECT p.id, 'gm', n, p.gm_numbers FROM catalog_parts p, unnest(p.gm_numbers) n
)
SELECT part_id, field, n AS number,
       CASE WHEN NOT (regexp_replace(upper(n), '[^A-Z0-9]', '', 'g') = ANY (arr)) THEN 'canonical form missing'
            WHEN length(regexp_replace(upper(n), '[^A-Z0-9]', '', 'g')) < 4 THEN 'too short'
            ELSE 'no digit' END AS problem
FROM nums
WHERE NOT (regexp_replace(upper(n), '[^A-Z0-9]', '', 'g') = ANY (arr))
   OR length(regexp_replace(upper(n), '[^A-Z0-9]', '', 'g')) < 4
   OR regexp_replace(upper(n), '[^A-Z0-9]', '', 'g') !~ '[0-9]'
LIMIT 100;

\echo '13. Wave 3 reach: parts filed under generation rows, now matched for a Garage vehicle whose generation resolves'
SELECT m.id AS generation, m.name, m.year_from, m.year_to,
       count(DISTINCT f.part_id) AS legacy_parts,
       count(DISTINCT f.part_id) FILTER (WHERE f.part_id IN (SELECT lp.id FROM catalog_parts lp JOIN catalog_sellers ls ON ls.id = lp.seller_id WHERE lp.images <> '{}' AND lp.price_uzs > 0 AND ls.status <> 'SUSPENDED')) AS buyer_listed,
       (SELECT count(DISTINCT b."partId") FROM fitment_bindings b WHERE b."vehicleModelId" = m.id) AS curated_parts
FROM vehicle_models m
JOIN vehicle_makes mk ON mk.id = m.make_id
LEFT JOIN catalog_part_fits f ON lower(btrim(f.make_name)) = lower(btrim(mk.name))
                              AND lower(btrim(f.model_name)) = lower(btrim(m.name))
WHERE to_jsonb(m) ->> 'variant_of_model_id' IS NOT NULL
GROUP BY m.id, m.name, m.year_from, m.year_to
ORDER BY m.year_from;
SELECT v.year,
       count(*) AS garage_vehicles_on_generic_model,
       count(*) FILTER (WHERE to_jsonb(v) ->> 'variant_model_id' IS NOT NULL) AS with_owner_pick,
       count(*) FILTER (WHERE v.trim_id IS NOT NULL) AS with_trim
FROM vehicles v
WHERE v.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM vehicle_models g WHERE to_jsonb(g) ->> 'variant_of_model_id' = v.model_id)
GROUP BY v.year
ORDER BY v.year;

\echo '14. OEM cross-reference CANDIDATES (evidence for review; nothing is imported from this):'
\echo '    a part with no fitment that shares an exact GM-labelled number with a curated part'
SELECT target.id AS part_without_fitment, n AS shared_gm_number, source.id AS curated_part,
       (SELECT string_agg(DISTINCT b."vehicleModelId", ', ') FROM fitment_bindings b WHERE b."partId" = source.id) AS curated_models
FROM catalog_parts target
CROSS JOIN LATERAL unnest(target.gm_numbers) n
JOIN catalog_parts source ON source.id <> target.id
                         AND source.part_number_type = 'GM'
                         AND n = ANY (source.gm_numbers)
WHERE target.part_number_type = 'GM'
  AND NOT target.is_universal
  AND NOT EXISTS (SELECT 1 FROM fitment_bindings b WHERE b."partId" = target.id)
  AND NOT EXISTS (SELECT 1 FROM catalog_part_fits f WHERE f.part_id = target.id)
  AND NOT EXISTS (SELECT 1 FROM catalog_part_make_fits f WHERE f.part_id = target.id)
  AND EXISTS (SELECT 1 FROM fitment_bindings b WHERE b."partId" = source.id)
  AND n ~ '^[0-9]{8}$'
ORDER BY 1
LIMIT 100;

ROLLBACK;
