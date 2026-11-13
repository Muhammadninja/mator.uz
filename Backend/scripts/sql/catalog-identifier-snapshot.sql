-- READ-ONLY catalog snapshot for the part-number data-quality audit (Wave 5).
-- Prints ONE JSON document and writes nothing: the query runs in a READ ONLY
-- transaction that is rolled back. It reads catalog_parts (id, title, brand,
-- number label, the two number arrays, the listing flags), whether each part
-- has any fitment row, and — for an imported position — its source part number
-- from products. No customer, order or payment data.
--
-- The arrays are emitted as JSON STRINGS, so leading zeros survive.
-- `listed` is BUYER_LISTED_PART (catalog/buyer-visibility.ts): seller not
-- SUSPENDED, at least one photo, a positive price. A hidden CATEGORY is not
-- evaluated here (the tree is resolved in code), so `listed` may be wider.
--
-- Run it from a FILE (psql -f, or \i inside psql). Do not paste it into an
-- interactive prompt.
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$READ_ONLY_URL" -X -q -A -t -f scripts/sql/catalog-identifier-snapshot.sql \
--     > catalog-identifier-snapshot.json
--
-- Then, anywhere (no database connection is made):
--   npm run catalog:identifier-audit -- --snapshot=catalog-identifier-snapshot.json
--   npm run catalog:search-compare -- --snapshot=catalog-identifier-snapshot.json
-- `created_at` is there for the comparison: it is the listing's default order.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

SELECT json_build_object(
  'kind', 'catalog-identifier-audit',
  'format_version', 1,
  'captured_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'database', current_database(),
  'parts', COALESCE((
    SELECT json_agg(json_build_object(
      'id', p.id,
      'title', p.title,
      'part_brand_name', p.part_brand_name,
      'brand_name', b.name,
      'part_number_type', p.part_number_type::text,
      'gm_numbers', to_json(p.gm_numbers),
      'oem_numbers', to_json(p.oem_numbers),
      'is_universal', p.is_universal,
      'created_at', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'listed', (
        s.status <> 'SUSPENDED'
        AND p.images IS NOT NULL AND p.images <> '{}'
        AND p.price_uzs > 0
      ),
      'has_fitment', (
        EXISTS (SELECT 1 FROM fitment_bindings f WHERE f."partId" = p.id)
        OR EXISTS (SELECT 1 FROM part_compatibilities c WHERE c.part_id = p.id)
        OR EXISTS (SELECT 1 FROM catalog_part_fits cf WHERE cf.part_id = p.id)
        OR EXISTS (SELECT 1 FROM catalog_part_make_fits mf WHERE mf.part_id = p.id)
      ),
      'source_part_number', src.source_part_number,
      'source_system', src.source_system
    ) ORDER BY p.id)
    FROM catalog_parts p
    JOIN catalog_sellers s ON s.id = p.seller_id
    LEFT JOIN part_brands b ON b.id = p.brand_id
    LEFT JOIN LATERAL (
      SELECT pr.source_part_number, st.source_system::text AS source_system
      FROM stocks st
      JOIN products pr ON pr.id = st.product_id
      WHERE p.id = 'part_stock_' || st.id::text
    ) src ON true
  ), '[]'::json)
);

ROLLBACK;
