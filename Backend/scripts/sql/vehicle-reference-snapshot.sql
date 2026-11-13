-- READ-ONLY snapshot of the vehicle reference tables for the reference seed's
-- offline dry-run. Prints ONE JSON document and writes nothing: the query runs
-- in a READ ONLY transaction that is rolled back. It reads vehicle_makes and
-- vehicle_models only (no customer data).
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$READ_ONLY_URL" -X -q -A -t -f scripts/sql/vehicle-reference-snapshot.sql \
--     > vehicle-reference-snapshot.json
--
-- Then, anywhere (no database connection is made):
--   npm run seed:vehicle-reference -- --dataset=wave-1 --snapshot=vehicle-reference-snapshot.json
-- Run it from a FILE (psql -f, or \i inside psql). Do not paste it into an
-- interactive prompt: a terminal that pastes carriage returns turns the whole
-- script into one line, and psql then reads it all as the `\set` argument.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

SELECT json_build_object(
  'captured_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'database', current_database(),
  'makes', COALESCE((
    SELECT json_agg(json_build_object(
      'id', id,
      'name', name,
      'is_active', is_active,
      'coming_soon', coming_soon,
      'sort_order', sort_order
    ) ORDER BY id)
    FROM vehicle_makes
  ), '[]'::json),
  'models', COALESCE((
    SELECT json_agg(json_build_object(
      'id', id,
      'make_id', make_id,
      'name', name,
      'sort_order', sort_order,
      'year_from', year_from,
      'year_to', year_to,
      'body_type', body_type,
      -- via to_jsonb: null, not an error, before migration 20261115000000
      'variant_of_model_id', to_jsonb(vm) ->> 'variant_of_model_id'
    ) ORDER BY id)
    FROM vehicle_models vm
  ), '[]'::json)
);

ROLLBACK;
