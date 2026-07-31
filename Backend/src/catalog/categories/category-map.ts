import { PartMainCategory, PartVehicleCategory } from '@prisma/client';
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

/**
 * PartVehicleCategory enum → its ROOT PartCategory id.
 *
 * NOT derivable from VEHICLE_CATEGORIES' slugs: the root for
 * PartVehicleCategory.ENGINE is 'engine-system', because the id 'engine' was
 * already taken by the level-1 main category PartMainCategory.ENGINE. This table
 * and the migration's CASE expression are the two places that encode that, and
 * they must agree.
 */
export const VEHICLE_CATEGORY_TO_SLUG: Record<PartVehicleCategory, string> = {
  [PartVehicleCategory.BRAKE_SYSTEM]: 'brake-system',
  [PartVehicleCategory.MAINTENANCE_AND_FLUIDS]: 'maintenance-and-fluids',
  [PartVehicleCategory.SUSPENSION_AND_STEERING]: 'suspension-and-steering',
  [PartVehicleCategory.ELECTRICAL_AND_LIGHTING]: 'electrical-and-lighting',
  [PartVehicleCategory.ENGINE]: 'engine-system',
  [PartVehicleCategory.TRANSMISSION]: 'transmission',
  [PartVehicleCategory.HEATING_AND_COOLING]: 'heating-and-cooling',
  [PartVehicleCategory.TUNING_AND_ACCESSORIES]: 'tuning-and-accessories',
};

/**
 * Reverse lookups: category id → the legacy enum it mirrors, or undefined for an
 * admin-created category that mirrors none. Used when a dynamic category pick
 * must also populate the legacy enum columns during the compatibility stage.
 */
export const MAIN_CATEGORY_BY_SLUG: ReadonlyMap<string, PartMainCategory> =
  new Map(
    Object.entries(MAIN_CATEGORY_TO_SLUG).map(([enumValue, slug]) => [
      slug,
      enumValue as PartMainCategory,
    ]),
  );

export const VEHICLE_CATEGORY_BY_SLUG: ReadonlyMap<
  string,
  PartVehicleCategory
> = new Map(
  Object.entries(VEHICLE_CATEGORY_TO_SLUG).map(([enumValue, slug]) => [
    slug,
    enumValue as PartVehicleCategory,
  ]),
);
