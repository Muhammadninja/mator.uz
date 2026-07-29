import { PartMainCategory } from '@prisma/client';
import { MAIN_CATEGORIES } from './part-categories.catalog';

/**
 * PartMainCategory enum → canonical PartCategory id (== slug).
 *
 * The 12 MAIN_CATEGORIES are the single source of truth for the buyer grid, and
 * each is stored as a PartCategory row whose `id` IS its slug (e.g. BRAKES →
 * 'brakes', OIL_AND_FLUIDS → 'oil-and-fluids'). This map is the one place that
 * turns a bot-assigned `mainCategory` into the category a part points at, reused
 * by the projection service (live ingest) and mirrored by the migration backfill.
 *
 * Built from MAIN_CATEGORIES so it can never drift from the catalog metadata.
 */
export const MAIN_CATEGORY_TO_SLUG: Record<PartMainCategory, string> =
  MAIN_CATEGORIES.reduce(
    (acc, c) => {
      acc[c.id] = c.slug;
      return acc;
    },
    {} as Record<PartMainCategory, string>,
  );
