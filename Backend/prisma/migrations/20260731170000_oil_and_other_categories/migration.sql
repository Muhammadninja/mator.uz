-- Motor-oil category + the admin-managed "Другое" subtree.
--
-- Two additions to the EXISTING PartCategory tree (no new table, no new enum):
--
--   1. 'motor-oil' — a level-0 category offered at the CATEGORY step AFTER the
--      seller picked a car. Choosing it starts the oil questionnaire while
--      KEEPING the chosen brand/model, which is what makes such a listing
--      vehicle-specific (is_universal = false).
--
--   2. 'other' — the root of the non-vehicle-specific catalogue, seeded with the
--      four requested children (Industrial Oil, Motorcycle Oil, Agricultural
--      Machinery, Other Lubricants). These are ORDINARY category rows: the admin
--      console renames, reorders, activates/deactivates and adds siblings through
--      the normal CRUD, and the bot picks the changes up on its next read with NO
--      redeploy. A listing under this subtree named no vehicle → universal.
--
-- Both are addressed by their STABLE IDS (see CategoryAnchor in
-- catalog/categories/category-map.ts). Behaviour is never keyed on a category's
-- name, so an admin may rename any of these freely.
--
-- Hand-written, IDEMPOTENT and safe to re-run: every row is upserted by its id
-- and the level/parent are set explicitly. Purely additive — no existing row,
-- column or enum is touched.

-- ── 1. The motor-oil category (level 0, offered next to the vehicle categories) ─
INSERT INTO "part_categories" ("id", "name", "slug", "color", "icon_key", "main_category", "level", "sort_order", "is_active", "created_at", "updated_at")
VALUES ('motor-oil', 'Моторные масла', 'motor-oil', '#00ACC1', 'oil', NULL, 0, 8, true, now(), now())
ON CONFLICT ("id") DO UPDATE SET
  "level"      = 0,
  "parent_id"  = NULL,
  "is_active"  = true,
  "updated_at" = now();

-- ── 2. The "Другое" root (level 0) ─────────────────────────────────────────────
-- sort_order 99 keeps it last among the roots; it is a catch-all, not a vehicle
-- system. It is NOT offered on the vehicle path — the bot reaches it only via the
-- "Другое" button — but it lives in the same tree so the admin CRUD manages it.
INSERT INTO "part_categories" ("id", "name", "slug", "color", "icon_key", "main_category", "level", "sort_order", "is_active", "created_at", "updated_at")
VALUES ('other', 'Другое', 'other', '#5F6368', 'other', NULL, 0, 99, true, now(), now())
ON CONFLICT ("id") DO UPDATE SET
  "level"      = 0,
  "parent_id"  = NULL,
  "is_active"  = true,
  "updated_at" = now();

-- ── 3. The initial "Другое" children (level 1) ─────────────────────────────────
-- A STARTING SET, not a fixed list: the admin panel adds/renames/removes these
-- like any other category. Only `sort_order` and the names are seeded; nothing in
-- the code refers to these four ids.
INSERT INTO "part_categories" ("id", "name", "slug", "parent_id", "main_category", "level", "sort_order", "is_active", "created_at", "updated_at")
VALUES
  ('industrial-oil',        'Индустриальные масла',      'industrial-oil',        'other', NULL, 1, 0, true, now(), now()),
  ('motorcycle-oil',        'Мотоциклетные масла',       'motorcycle-oil',        'other', NULL, 1, 1, true, now(), now()),
  ('agricultural-machinery','Сельхозтехника',            'agricultural-machinery','other', NULL, 1, 2, true, now(), now()),
  ('other-lubricants',      'Прочие смазочные материалы','other-lubricants',      'other', NULL, 1, 3, true, now(), now())
ON CONFLICT ("id") DO UPDATE SET
  "parent_id"  = 'other',
  "level"      = 1,
  "updated_at" = now();
