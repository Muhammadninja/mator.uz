-- The Tasnif package code for a consumer box, next to the codes for a piece and a set.
--
-- Tasnif issues package codes per MXIK, so there is no universal code for a box: an
-- operator enters the one listed for the category's own MXIK. Deliberately NOT
-- backfilled, even where the classifier lists a box: a category holding a second code
-- starts asking how each listing is sold, which only an operator should turn on.
--
-- ── part_categories.fiscal_confirmed_codes ──
-- Widened to fit a fourth code. Worst case is 17 + 3 * 20 digits and 3 separators = 80.
-- Widening a VARCHAR does not rewrite the table. A category with no box code keeps its
-- three-part string, so nothing already confirmed stops being confirmed.
ALTER TABLE "part_categories"
  ADD COLUMN "package_code_box" VARCHAR(20),
  ALTER COLUMN "fiscal_confirmed_codes" TYPE VARCHAR(80);
