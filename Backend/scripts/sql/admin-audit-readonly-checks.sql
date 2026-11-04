-- READ-ONLY checks for data left behind by the admin-panel bugs fixed with this
-- audit. Nothing here writes: the whole file runs inside a READ ONLY transaction
-- that is rolled back. Run it by hand, and decide row by row from the results; no
-- repair is automated, because an old row may be correct for reasons this file
-- cannot see.
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$READ_ONLY_REPLICA_URL" -X -f scripts/sql/admin-audit-readonly-checks.sql
--
-- The output names customers' orders and administrators' emails: keep it private.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
-- Allowed in a read-only transaction: it only bounds how long a check may run.
SET LOCAL statement_timeout = '60s';

\echo '1. Categories orphaned by a delete race (a non-root level with no parent)'
SELECT id, level, is_active FROM part_categories
WHERE parent_id IS NULL AND level > 0 AND id <> 'cat_uncategorized';

\echo '2. Cycles: nodes no walk from a root ever reaches (invisible in every tree)'
WITH RECURSIVE reachable AS (
  SELECT id FROM part_categories WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id FROM part_categories c JOIN reachable r ON c.parent_id = r.id
)
SELECT c.id, c.parent_id, c.level FROM part_categories c
WHERE c.id NOT IN (SELECT id FROM reachable);

\echo '3. Stored level that disagrees with the parent chain, or past the depth cap (4)'
WITH RECURSIVE walk AS (
  SELECT id, 0 AS depth FROM part_categories WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, w.depth + 1 FROM part_categories c JOIN walk w ON c.parent_id = w.id
)
SELECT c.id, c.level AS stored_level, w.depth AS real_depth FROM part_categories c
JOIN walk w ON w.id = c.id
WHERE (c.level <> w.depth AND c.id <> 'cat_uncategorized') OR w.depth > 4;

\echo '4. Load-bearing categories that no longer exist'
SELECT expected.id FROM (VALUES
  ('cat_uncategorized'), ('maintenance-and-fluids'),
  ('motor-oil'), ('other'), ('antifreeze'), ('transmission-oil'),
  ('synthetic-motor-oil'), ('semi-synthetic-motor-oil'), ('mineral-motor-oil'),
  ('brakes'), ('batteries'), ('filters'), ('ignition'), ('engine'),
  ('electrical-parts'), ('oil-and-fluids'), ('belts-and-hoses'),
  ('wipers'), ('lighting'), ('suspension'), ('exterior')
) AS expected(id)
LEFT JOIN part_categories c ON c.id = expected.id
WHERE c.id IS NULL;

\echo '5. Home-grid buckets mirrored by more than one row (duplicate tiles)'
SELECT main_category, array_agg(id) AS ids FROM part_categories
WHERE main_category IS NOT NULL GROUP BY main_category HAVING COUNT(*) > 1;

\echo '6. Listings stranded by a missing bucket row: their next projection fails on the FK'
SELECT p.id AS product_id, p.main_category FROM products p
WHERE p.category_id IS NULL AND p.main_category IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM part_categories c WHERE c.main_category = p.main_category
  );

\echo '7. Sale targets pointing at a category that is gone (the sale silently stopped matching)'
SELECT t.sale_id, t.target_id, s.title, s.is_active FROM sale_targets t
JOIN sales s ON s.id = t.sale_id
LEFT JOIN part_categories c ON c.id = t.target_id
WHERE t.target_type = 'CATEGORIES' AND c.id IS NULL AND s.deleted_at IS NULL;

\echo '8. Cash/terminal orders the sweeper expired: real orders nobody confirmed in time'
SELECT o.id, o.payment_type, o.total_uzs, o.created_at, o.user_id FROM orders o
WHERE o.status = 'EXPIRED' AND o.payment_type IN ('CASH', 'TERMINAL')
ORDER BY o.created_at DESC;

\echo '9. Online orders past payment with no payment on file (marked paid by hand)'
SELECT o.id, o.status, o.total_uzs, o.created_at FROM orders o
WHERE (
    o.payment_type = 'PAYME'
    OR (o.payment_type IS NULL AND EXISTS (
      SELECT 1 FROM payments p WHERE p.order_id = o.id
    ))
  )
  AND o.status IN ('PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED')
  AND NOT EXISTS (
    SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'PAID'
  )
ORDER BY o.created_at DESC;

\echo '10. Orders an operator marked REFUNDED while the payment still reads PAID'
SELECT o.id, o.total_uzs, p.id AS payment_id, p.provider FROM orders o
JOIN payments p ON p.order_id = o.id
WHERE o.status = 'REFUNDED' AND p.status = 'PAID';

\echo '11. Cancelled orders holding a settled payment: a refund may still be owed'
SELECT o.id, o.total_uzs, p.id AS payment_id, p.provider, p.paid_at FROM orders o
JOIN payments p ON p.order_id = o.id
WHERE o.status = 'CANCELLED' AND p.status = 'PAID'
ORDER BY p.paid_at DESC;

\echo '12. Suspended dealers still carrying a trust badge'
SELECT id, name, certified, lowest_price FROM catalog_sellers
WHERE status = 'SUSPENDED' AND (certified OR lowest_price);

\echo '13. Live admin sessions per administrator (panel logout never revoked these)'
SELECT a.email, a.role, COUNT(*) AS live_sessions, MAX(t.last_used_at) AS last_used
FROM admin_refresh_tokens t JOIN app_admins a ON a.id = t.admin_id
WHERE t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()
GROUP BY a.email, a.role ORDER BY live_sessions DESC;

\echo '14. Parts priced at zero or below: buyable before this fix, delisted and refused after it'
\echo '    stock_price_uzs is where a re-projection takes the price from: if it is zero too, fix it there as well, or the fix comes undone'
SELECT p.id, p.title, p.price_uzs, st.price_uzs AS stock_price_uzs, st.source_system,
       p.stock_qty, p.seller_id, s.status AS seller_status
FROM catalog_parts p
LEFT JOIN catalog_sellers s ON s.id = p.seller_id
LEFT JOIN stocks st ON st.id = substring(p.id from '^part_stock_([0-9]+)$')::int
WHERE p.price_uzs <= 0
ORDER BY p.stock_qty DESC, p.id;

\echo '15. Categories whose slug differs from their id (the slug is what Fitment Studio matches on)'
SELECT id, slug, level, is_active FROM part_categories
WHERE slug IS DISTINCT FROM id
ORDER BY id;

\echo '16. Unfinished percentage sales of 100 or more: they make a line free, which checkout refuses'
SELECT id, title, discount_value, is_active, start_at, end_at FROM sales
WHERE discount_type = 'PERCENT' AND discount_value >= 100
  AND deleted_at IS NULL AND (end_at IS NULL OR end_at > now())
ORDER BY start_at DESC;

\echo '17. Cash/terminal orders waiting for an operator longer than the default 2 hour SLA'
SELECT id, payment_type, total_uzs, created_at, now() - created_at AS waiting, user_id FROM orders
WHERE status = 'PENDING_PAYMENT' AND payment_type IN ('CASH', 'TERMINAL')
  AND created_at < now() - interval '2 hours'
ORDER BY created_at;

ROLLBACK;
