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

// ── Category fiscal data (MXIK / ИКПУ + Tasnif package codes) ────────────────
/**
 * The KNOWN fiscal configuration, keyed by stable category id. Mirrors the
 * UPDATE block in migrations/20260811000000_add_fiscal_data exactly, so a
 * freshly seeded database and a migrated one converge — the same contract the
 * category tree itself already follows.
 *
 * Two rules governed every entry, and nothing else:
 *
 * 1. MATCHED BY TREE POSITION, NOT BY NAME. A listing always lands on a LEAF
 *    (the wizard keeps a root only when that root has no children), so the codes
 *    are attached to the leaf the supplied entry describes. That is why "Brake
 *    system" configures `brakes` — the sole leaf under the `brake-system` root —
 *    while "Transmission" and "A/C" configure the childless roots `transmission`
 *    and `heating-and-cooling` directly. Configuring a parent that has children
 *    would leave its codes unreachable by every product.
 *
 * 2. NOTHING IS INVENTED. A category the supplied list does not describe stays
 *    unconfigured until an admin enters real values; no code is reused, guessed
 *    or extrapolated from a neighbouring category.
 *
 * NOT HERE — the motor-oil codes, on purpose. The supplied list carries three
 * of them, one per oil TYPE (synthetic / semi-synthetic / mineral), because the
 * registry classifies oil by base composition. That is an ATTRIBUTE of a
 * listing here (Product.oilType, asked by the wizard), not a category, and a
 * single node cannot hold three MXIKs — so the oil codes live in
 * OIL_TYPE_FISCAL (common/fiscal.util.ts) and are resolved per listing.
 *
 * ANTIFREEZE is NOT one of those: it is classified as an ordinary category (one
 * MXIK for the whole leaf, not one per attribute), so its codes live here with
 * every other category's — which is what keeps an antifreeze listing off the
 * motor-oil codes.
 *
 * The oil categories therefore stay EMPTY here and are still fiscally complete:
 * `isFiscalizedByOilType` (catalog/categories/category-map.ts) is what tells the
 * admin console not to report them as unconfigured. Note the exception —
 * 'oil-and-fluids' is a SPARE_PART leaf under maintenance-and-fluids whose
 * listings never answer the oil question, so it is on the ordinary category
 * path and simply has no codes in the supplied list.
 */
export const CATEGORY_FISCAL_DATA: Readonly<
  Record<
    string,
    { mxik: string; packageCodeSingle: string; packageCodeSet?: string }
  >
> = {
  // Sold in both forms — these three make the bot ask "Штука / Комплект".
  brakes: {
    mxik: '08708005011000000',
    packageCodeSingle: '1417722',
    packageCodeSet: '1417723',
  },
  transmission: {
    mxik: '08708006003000000',
    packageCodeSingle: '1417580',
    packageCodeSet: '1417581',
  },
  suspension: {
    mxik: '08708009002000000',
    packageCodeSingle: '1417721',
    packageCodeSet: '1417718',
  },
  // Sold in one form only — no question is asked and the single code applies.
  filters: { mxik: '08421002001000000', packageCodeSingle: '1499205' },
  // The `antifreeze` leaf under maintenance-and-fluids. Operator-supplied, like
  // every other entry here. It is an ORDINARY category on the fiscal path — the
  // ANTIFREEZE questionnaire asks no oil type, so `isFiscalizedByOilType` is
  // false for it and these are the codes its listings actually use.
  antifreeze: { mxik: '03820001001000000', packageCodeSingle: '1513835' },
  // The `transmission-oil` leaf under motor-oil — the one option on the oil
  // screen that is NOT a base composition. Its three siblings (synthetic /
  // semi-synthetic / mineral) are fiscalized from the oilType they derive, and
  // deliberately carry no codes here; transmission oil derives no oilType, so
  // it is on the ORDINARY category path and needs its own. Operator-supplied,
  // like every other entry.
  'transmission-oil': {
    mxik: '02710005005000000',
    packageCodeSingle: '1282593',
  },
  wipers: { mxik: '08512900001000000', packageCodeSingle: '1866417' },
  batteries: { mxik: '08507001009000000', packageCodeSingle: '1431941' },
  // "Spark Plug" → the ignition leaf; "Starter" → the electrical-parts leaf.
  // Both supplied codes are 8511 (ignition/starting equipment) and each names
  // the flagship part of the leaf it is attached to.
  ignition: { mxik: '08511001002000000', packageCodeSingle: '1350138' },
  'electrical-parts': {
    mxik: '08511001001000000',
    packageCodeSingle: '1350563',
  },
  // "Headlight" → the lighting leaf (8512 = lighting equipment).
  lighting: { mxik: '08512001010000000', packageCodeSingle: '1350743' },
  engine: { mxik: '08407001001000000', packageCodeSingle: '1444123' },
  // "Rubber Hoses" → the belts-and-hoses leaf (4009 = rubber tubes/hoses).
  'belts-and-hoses': {
    mxik: '04009001012000000',
    packageCodeSingle: '1342595',
  },
  // "A/C" → the childless heating-and-cooling root (8415 = air conditioning).
  'heating-and-cooling': {
    mxik: '08415001012000000',
    packageCodeSingle: '1462732',
  },
  exterior: { mxik: '08708002001000000', packageCodeSingle: '1417557' },
};

/**
 * The fiscal columns to write for a category, or `{}` when none are known.
 *
 * Returning nothing for an unknown category is what keeps the seed from
 * CLEARING fiscal data an operator entered by hand: an absent key is not
 * written, so a re-run leaves it untouched (unlike name/color, which the seed
 * owns and restores).
 */
export function fiscalDataFor(categoryId: string): {
  mxik?: string;
  packageCodeSingle?: string;
  packageCodeSet?: string | null;
} {
  const fiscal = Object.prototype.hasOwnProperty.call(
    CATEGORY_FISCAL_DATA,
    categoryId,
  )
    ? CATEGORY_FISCAL_DATA[categoryId]
    : undefined;
  if (!fiscal) return {};
  return {
    mxik: fiscal.mxik,
    packageCodeSingle: fiscal.packageCodeSingle,
    // Explicit null for a single-form category: re-seeding must not leave a set
    // code behind if one was configured for a category that no longer has one.
    packageCodeSet: fiscal.packageCodeSet ?? null,
  };
}

// ── Dealers ──────────────────────────────────────────────────────────────────
// Intentionally empty. Real MATOR Certified dealers are now created by operators
// in the admin console (POST /v1/admin/dealers) with their real name and brand
// logo, so the app's certified rail shows genuine storefronts rather than the
// old placeholder mocks (AutoPro / Prime Motors / …). Left as an empty seed —
// not deleted — so `seedDealers()` stays a no-op rather than a missing import,
// and a fresh database starts with no fake dealers.
export const SEED_DEALERS: SeedDealer[] = [];
