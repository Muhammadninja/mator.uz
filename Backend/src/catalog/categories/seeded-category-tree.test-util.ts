/**
 * TEST-ONLY: the PartCategory tree, as tests that walk it need it.
 *
 * SEEDED_TREE is what a freshly seeded database holds, assembled from the seed
 * modules themselves (never transcribed), so it follows the seeds as they
 * change:
 *   roots    SEED_ROOT_CATEGORIES (the 8 systems + motor-oil + other) and the
 *            projection's own 'cat_uncategorized' fallback
 *   buckets  SEED_CATEGORIES — the 12 home-grid rows, level 1 under a system
 *   subs     TAXONOMY (subcategory-taxonomy.seed.ts)
 *   other    SEED_OTHER_CATEGORIES, under the "Другое" root
 *
 * LIVE_TREE adds what production holds beyond the seed — nodes an admin
 * created, and the two subs filed under 'other' instead of
 * 'cat_uncategorized' — as read from GET /v1/reference/categories on
 * 2026-10-20. Only the shape the bucket rules must survive is kept.
 */
import {
  SEED_CATEGORIES,
  SEED_OTHER_CATEGORIES,
  SEED_ROOT_CATEGORIES,
} from '../../prisma/seed-data/catalog-reference.seed';
import { TAXONOMY } from '../../prisma/seed-data/subcategory-taxonomy.seed';
import { CategoryAnchor, categoryParentMap } from './category-map';

export interface TreeRow {
  id: string;
  parentId: string | null;
}

export const SEEDED_TREE: readonly TreeRow[] = [
  ...SEED_ROOT_CATEGORIES.map((r) => ({ id: r.id, parentId: null })),
  { id: 'cat_uncategorized', parentId: null },
  ...SEED_CATEGORIES.map((c) => ({ id: c.id, parentId: c.parentId })),
  ...TAXONOMY.flatMap((group) =>
    group.subs.map((s) => ({ id: s.slug, parentId: group.parentId })),
  ),
  ...SEED_OTHER_CATEGORIES.map((c) => ({
    id: c.id,
    parentId: CategoryAnchor.OTHER,
  })),
];

/** Seeded nodes no other seeded node hangs under — where listings are filed. */
export const SEEDED_LEAF_IDS: readonly string[] = SEEDED_TREE.map(
  (r) => r.id,
).filter((id) => !SEEDED_TREE.some((r) => r.parentId === id));

/** Nodes production holds that the seed does not (admin-created). */
export const PRODUCTION_ONLY_NODES: readonly TreeRow[] = [
  { id: 'tire-pressure-sensors', parentId: 'electrical-and-lighting' },
  { id: 'remote-keys', parentId: 'electrical-and-lighting' },
  { id: 'sealants', parentId: 'maintenance-and-fluids' },
  { id: 'fuel-and-oil-pumps', parentId: 'engine-system' },
  { id: 'cameras', parentId: 'tuning-and-accessories' },
  { id: 'car-glass', parentId: 'tuning-and-accessories' },
  { id: 'safety-kits', parentId: 'tuning-and-accessories' },
  { id: 'tint-films', parentId: 'tuning-and-accessories' },
  { id: 'wheel-rims', parentId: 'tuning-and-accessories' },
];

/** Production's tree: the seed, its extra nodes, and its two re-parented subs. */
export const LIVE_TREE: readonly TreeRow[] = [
  ...SEEDED_TREE.map((r) =>
    r.id === 'wiper-blades' || r.id === 'fasteners-and-clips'
      ? { ...r, parentId: CategoryAnchor.OTHER }
      : r,
  ),
  ...PRODUCTION_ONLY_NODES,
];

export const SEEDED_PARENTS = categoryParentMap(SEEDED_TREE);
export const LIVE_PARENTS = categoryParentMap(LIVE_TREE);
