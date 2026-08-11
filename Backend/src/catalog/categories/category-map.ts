import {
  PartMainCategory,
  PartVehicleCategory,
  ProductKind,
} from '@prisma/client';
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
 * STABLE ANCHOR IDS — the few PartCategory rows the application must be able to
 * find by identity rather than by position in the tree.
 *
 * Behaviour is keyed on these ids, NEVER on a category's name: an admin may
 * rename "Моторные масла" freely and the oil questionnaire still starts. They
 * are ordinary PartCategory rows in every other respect — the admin can rename,
 * reorder, activate/deactivate them and manage their children through the normal
 * CRUD. Only the id is load-bearing.
 */
export const CategoryAnchor = {
  /**
   * The oil category offered at the CATEGORY step, AFTER a vehicle was chosen.
   * Picking it starts the oil questionnaire while keeping brand/model, which is
   * what makes such a listing vehicle-specific (NOT universal).
   */
  MOTOR_OIL: 'motor-oil',
  /**
   * Root of the "Другое" subtree: the non-vehicle-specific catalogue (Industrial
   * Oil, Motorcycle Oil, Agricultural Machinery, …). Its ACTIVE CHILDREN are what
   * the bot lists after the seller taps "Другое", loaded live from the tree so an
   * admin can add one with no redeploy. A listing under this subtree named no
   * vehicle and is therefore universal.
   */
  OTHER: 'other',
} as const;

/**
 * Category id → the questionnaire it starts. Only categories that CHANGE the
 * kind appear here; everything else leaves the session's kind untouched.
 *
 * Keyed by id so a rename is harmless. Adding a genuinely new questionnaire
 * still needs a ProductKind + its columns + a FLOWS entry (a code change); what
 * needs NO code change is adding an admin-managed category under OTHER, which
 * is pure taxonomy and keeps the oil questionnaire.
 */
export const CATEGORY_ID_TO_KIND: Readonly<Record<string, ProductKind>> = {
  [CategoryAnchor.MOTOR_OIL]: ProductKind.MOTOR_OIL,
};

/**
 * Whether listings of this category are fiscalized from their OIL TYPE rather
 * than from the category's own MXIK / package codes.
 *
 * These are exactly the categories whose listings come out as MOTOR_OIL, and
 * the two ways that happens are already encoded in the wizard: the `motor-oil`
 * anchor (CATEGORY_ID_TO_KIND) and any child of the "Другое" root, where
 * `selectOtherCategory` defaults every child to the oil questionnaire. The rule
 * is stated once here so the admin console, the seed and the receipt builder
 * agree on which categories are legitimately left without codes.
 *
 * Such a category is fiscally COMPLETE with no columns filled in: its products'
 * codes come from OIL_TYPE_FISCAL (see common/fiscal.util.ts), which is why an
 * empty `mxik` there is not a configuration gap.
 */
export function isFiscalizedByOilType(category: {
  id: string;
  parentId: string | null;
}): boolean {
  return (
    category.id === CategoryAnchor.MOTOR_OIL ||
    category.parentId === CategoryAnchor.OTHER
  );
}

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
