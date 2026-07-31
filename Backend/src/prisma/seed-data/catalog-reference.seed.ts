/**
 * Non-vehicle reference data — transcribed BIT-FOR-BIT from the frontend source
 * of truth. Frontend wins on every value; nothing normalized or "improved".
 *
 * Sources:
 *   • CATEGORY tiles / systems  → constants/catalog-systems.ts (CATALOG_SYSTEMS)
 *   • DEALERS                    → mocks/mator-catalog.ts (MATOR_DEALERS)
 *
 * WHAT IS AND ISN'T STORED (schema is UNCHANGED):
 *   • Categories → PartCategory table (id = frontend system id, e.g. "brakes").
 *     Frontend labelRu / categoryKey / iconKey have no columns → recorded in
 *     DROPPED_FRONTEND_METADATA. The 8 systems ARE the buyer-facing category
 *     rows; the two backend enums (PartMainCategory 12, PartVehicleCategory 8)
 *     are a SEPARATE classification axis and are NOT seeded (enums, not rows).
 *   • Dealers → CatalogSeller table. Frontend initial/color/orders/years have no
 *     columns → recorded in DROPPED_FRONTEND_METADATA; only id/name are stored.
 *
 * REGIONS and QUICK FILTERS are intentionally NOT in this file — see the note in
 * seed.ts: the schema has no table for either (regions = PartOriginRegion enum +
 * ingestion classifier; quick filters = derived live from inventory). Seeding
 * them would require inventing tables, which the projection rules forbid.
 */

import { PartMainCategory } from '@prisma/client';
import {
  CategoryAnchor,
  VEHICLE_CATEGORY_TO_SLUG,
} from '../../catalog/categories/category-map';
import {
  MAIN_CATEGORIES,
  VEHICLE_CATEGORIES,
} from '../../catalog/categories/part-categories.catalog';

export interface SeedCategory {
  id: string;
  name: string; // English label (schema PartCategory.name)
  slug: string;
  color: string;
  iconKey: string;
  mainCategory: PartMainCategory;
  sortOrder: number;
  /** The root (vehicle) category this main category hangs under. */
  parentId: string;
  level: number;
}

/** A child of the "Другое" root — pure taxonomy, no enum mirror. */
export interface SeedOtherCategory {
  id: string;
  name: string;
  sortOrder: number;
}

/** A level-0 vehicle category. Carries no PartMainCategory mirror. */
export interface SeedRootCategory {
  id: string;
  name: string;
  slug: string;
  color: string;
  iconKey: string;
  sortOrder: number;
}

/**
 * PartMainCategory → the PartVehicleCategory root it belongs under, as the
 * Telegram wizard has always paired them (SUBCATEGORIES in wizard-catalog.ts).
 * The migration's UPDATE statements encode the identical mapping.
 */
const VEHICLE_CATEGORY_PARENT_OF: Record<PartMainCategory, string> = {
  [PartMainCategory.BRAKES]: 'brake-system',
  [PartMainCategory.FILTERS]: 'maintenance-and-fluids',
  [PartMainCategory.OIL_AND_FLUIDS]: 'maintenance-and-fluids',
  [PartMainCategory.WIPERS]: 'maintenance-and-fluids',
  [PartMainCategory.SUSPENSION]: 'suspension-and-steering',
  [PartMainCategory.BATTERIES]: 'electrical-and-lighting',
  [PartMainCategory.ELECTRICAL_PARTS]: 'electrical-and-lighting',
  [PartMainCategory.IGNITION]: 'electrical-and-lighting',
  [PartMainCategory.LIGHTING]: 'electrical-and-lighting',
  [PartMainCategory.ENGINE]: 'engine-system',
  [PartMainCategory.BELTS_AND_HOSES]: 'engine-system',
  [PartMainCategory.EXTERIOR]: 'tuning-and-accessories',
};

export interface SeedDealer {
  id: string;
  name: string;
  ratingAvg: number;
  initial: string;
  color: string;
  orders: string;
  years: number;
}

// ── Categories (the 12 canonical PartCategory rows = source of truth) ─────────
// PartCategory is now the single source of truth for the buyer grid, so a fresh
// database must be seeded with the SAME 12 canonical rows the migration upserts
// (id = slug, main_category = the mirrored enum). Derived from MAIN_CATEGORIES so
// the seed can never drift from the catalog metadata. The old 8-slug CATALOG_
// SYSTEMS list was replaced — those ids ('maintenance','climate',…) are the
// orphan rows the migration deactivates.
export const SEED_CATEGORIES: SeedCategory[] = MAIN_CATEGORIES.map((c, i) => ({
  id: c.slug,
  name: c.name,
  slug: c.slug,
  color: c.color,
  iconKey: c.iconKey,
  mainCategory: c.id,
  sortOrder: i,
  // Parented below, once the roots exist.
  parentId: VEHICLE_CATEGORY_PARENT_OF[c.id],
  level: 1,
}));

/**
 * The level-0 ROOT categories: the vehicle categories the seller bot lists
 * first. Derived from VEHICLE_CATEGORIES so the seed cannot drift from the
 * catalog metadata.
 *
 * The id is taken from {@link VEHICLE_CATEGORY_TO_SLUG}, NOT from the entry's own
 * slug: PartVehicleCategory.ENGINE's root is 'engine-system' because 'engine' is
 * already the level-1 main category PartMainCategory.ENGINE. The migration
 * encodes the same exception.
 */
export const SEED_ROOT_CATEGORIES: SeedRootCategory[] = VEHICLE_CATEGORIES.map(
  (c, i) => ({
    id: VEHICLE_CATEGORY_TO_SLUG[c.id],
    name: c.name,
    slug: VEHICLE_CATEGORY_TO_SLUG[c.id],
    color: c.color,
    iconKey: c.iconKey,
    sortOrder: i,
  }),
).concat([
  // The motor-oil category, offered at the CATEGORY step alongside the vehicle
  // systems. Picking it AFTER a car was chosen starts the oil questionnaire and
  // keeps that car → the listing is vehicle-specific, not universal.
  {
    id: CategoryAnchor.MOTOR_OIL,
    name: 'Моторные масла',
    slug: CategoryAnchor.MOTOR_OIL,
    color: '#00ACC1',
    iconKey: 'oil',
    sortOrder: VEHICLE_CATEGORIES.length,
  },
  // The "Другое" root. Reached by its own button rather than the category grid
  // (findRootCategories excludes it); its CHILDREN are the admin-managed
  // catalogue the bot lists there.
  {
    id: CategoryAnchor.OTHER,
    name: 'Другое',
    slug: CategoryAnchor.OTHER,
    color: '#5F6368',
    iconKey: 'other',
    sortOrder: 99,
  },
]);

/**
 * The STARTING children of "Другое" — not a fixed list. The admin panel adds,
 * renames, reorders and deactivates these like any other category, and the bot
 * picks the changes up on its next read with no redeploy. Nothing in the code
 * refers to these ids.
 */
export const SEED_OTHER_CATEGORIES: SeedOtherCategory[] = [
  { id: 'industrial-oil', name: 'Индустриальные масла', sortOrder: 0 },
  { id: 'motorcycle-oil', name: 'Мотоциклетные масла', sortOrder: 1 },
  { id: 'agricultural-machinery', name: 'Сельхозтехника', sortOrder: 2 },
  { id: 'other-lubricants', name: 'Прочие смазочные материалы', sortOrder: 3 },
];

// ── Dealers ──────────────────────────────────────────────────────────────────
// Intentionally empty. Real MATOR Certified dealers are now created by operators
// in the admin console (POST /v1/admin/dealers) with their real name and brand
// logo, so the app's certified rail shows genuine storefronts rather than the
// old placeholder mocks (AutoPro / Prime Motors / …). Left as an empty seed —
// not deleted — so `seedDealers()` stays a no-op rather than a missing import,
// and a fresh database starts with no fake dealers.
export const SEED_DEALERS: SeedDealer[] = [];
