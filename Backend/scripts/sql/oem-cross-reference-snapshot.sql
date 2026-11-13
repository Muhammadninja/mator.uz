-- READ-ONLY catalog snapshot for the OEM cross-reference dry-run (Wave 4).
-- Prints ONE JSON document and writes nothing: the query runs in a READ ONLY
-- transaction that is rolled back. It reads catalog_parts only (id, title,
-- part brand, number label and the two number arrays): no customer data, no
-- fitment tables, and not oem_compatibility (that table is OEM -> vehicle
-- fitment, not cross-reference).
--
-- The arrays are emitted as JSON STRINGS, so leading zeros survive.
--
-- Run it from a FILE (psql -f, or \i inside psql). Do not paste it into an
-- interactive prompt.
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$READ_ONLY_URL" -X -q -A -t -f scripts/sql/oem-cross-reference-snapshot.sql \
--     > oem-xref-snapshot.json
--
-- Then, anywhere (no database connection is made):
--   npm run oem-xref:dry-run -- --dataset=wave-4 --snapshot=oem-xref-snapshot.json
--
-- Starting point: section 14 of fitment-readonly-report.sql (Wave 3). The
-- dry-run's finder is broader on purpose (every pair of listings sharing an
-- exact 8-digit GM-labelled number, whatever their fitment) and stricter on
-- labels (per number, not per part_number_type), and it proposes candidates
-- for review only.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

SELECT json_build_object(
  'kind', 'oem-xref-catalog',
  'format_version', 1,
  'captured_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'database', current_database(),
  'parts', COALESCE((
    SELECT json_agg(json_build_object(
      'id', p.id,
      'title', p.title,
      'part_brand_name', p.part_brand_name,
      'part_number_type', p.part_number_type::text,
      'gm_numbers', to_json(p.gm_numbers),
      'oem_numbers', to_json(p.oem_numbers)
    ) ORDER BY p.id)
    FROM catalog_parts p
  ), '[]'::json)
);

ROLLBACK;
