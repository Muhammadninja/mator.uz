import {
  OilType,
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
  /**
   * The antifreeze category, reached from the "Другое" branch's "Что продаёте?"
   * question. It is an EXISTING node of the buyer tree — the `Антифризы` leaf
   * under `maintenance-and-fluids` seeded by subcategory-taxonomy.seed.ts — not
   * a parallel taxonomy invented for the bot: an antifreeze listing therefore
   * lands exactly where a buyer browsing antifreeze already looks, and its
   * MXIK / package codes come from that node's own fiscal columns.
   */
  ANTIFREEZE: 'antifreeze',
  /**
   * Transmission oil — a child of {@link CategoryAnchor.MOTOR_OIL} and the ONE
   * category the oil-type screen offers beside the three OIL_TYPES. It is a
   * product TYPE, not a base composition and not a viscosity, so a listing filed
   * here carries NO oilType and is fiscalized from this node's own MXIK /
   * package codes — never from the motor-oil codes, which are per oil type.
   */
  TRANSMISSION_OIL: 'transmission-oil',
  /**
   * The three motor-oil BASE COMPOSITIONS, as categories.
   *
   * The seller picks one of these instead of answering a separate "тип масла"
   * question: the composition IS the category. Each carries the registry's MXIK
   * for that composition, which is why they are anchors — behaviour (the fiscal
   * code, and the fact that picking one starts the oil questionnaire) is keyed
   * on these ids, never on their names, so an admin may rename them freely.
   */
  SYNTHETIC_MOTOR_OIL: 'synthetic-motor-oil',
  SEMI_SYNTHETIC_MOTOR_OIL: 'semi-synthetic-motor-oil',
  MINERAL_MOTOR_OIL: 'mineral-motor-oil',
} as const;

/**
 * The FOUR categories offered under "Моторное масло", in display order.
 *
 * One list, read by both wizard paths (vehicle and "Другое") and by the tests
 * that assert they agree — the two showing different options is exactly the bug
 * this replaces.
 */
export const MOTOR_OIL_CATEGORY_IDS: readonly string[] = [
  CategoryAnchor.SYNTHETIC_MOTOR_OIL,
  CategoryAnchor.SEMI_SYNTHETIC_MOTOR_OIL,
  CategoryAnchor.MINERAL_MOTOR_OIL,
  CategoryAnchor.TRANSMISSION_OIL,
];

/**
 * Category id → the base composition it denotes. DERIVED, never asked.
 *
 * `Product.oilType` remains the single input to the registry's oil codes
 * (OIL_TYPE_FISCAL) and to the buyer catalog's type facet, so it keeps being
 * populated — but from the category the seller chose rather than from a question
 * of its own. That removes the two-sources-of-truth problem: there is one
 * choice, and this table is the only thing that turns it into an attribute.
 *
 * `transmission-oil` is absent ON PURPOSE. It is not a base composition, there
 * is no OilType for it, and inventing one would divert its receipt onto a
 * motor-oil MXIK. It is fiscalized from its own category columns instead.
 */
export const OIL_TYPE_BY_CATEGORY: Readonly<Partial<Record<string, OilType>>> =
  {
    [CategoryAnchor.SYNTHETIC_MOTOR_OIL]: OilType.SYNTHETIC,
    [CategoryAnchor.SEMI_SYNTHETIC_MOTOR_OIL]: OilType.SEMI_SYNTHETIC,
    [CategoryAnchor.MINERAL_MOTOR_OIL]: OilType.MINERAL,
  };

/**
 * The base composition a category denotes, or null when it denotes none
 * (transmission oil, and every non-oil category).
 *
 * Own-property check only, so a category whose id happens to be 'constructor'
 * or 'toString' cannot inherit a truthy value off Object.prototype.
 */
export function oilTypeForCategory(categoryId: string | null): OilType | null {
  if (categoryId === null) return null;
  if (!Object.prototype.hasOwnProperty.call(OIL_TYPE_BY_CATEGORY, categoryId)) {
    return null;
  }
  const type: OilType | undefined = OIL_TYPE_BY_CATEGORY[categoryId];
  return type ?? null;
}

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
  // The three compositions and transmission oil all run the OIL questionnaire
  // (viscosity → volume). They differ in the codes they carry, not in what the
  // seller is asked, which is why they share a kind.
  [CategoryAnchor.SYNTHETIC_MOTOR_OIL]: ProductKind.MOTOR_OIL,
  [CategoryAnchor.SEMI_SYNTHETIC_MOTOR_OIL]: ProductKind.MOTOR_OIL,
  [CategoryAnchor.MINERAL_MOTOR_OIL]: ProductKind.MOTOR_OIL,
  [CategoryAnchor.TRANSMISSION_OIL]: ProductKind.MOTOR_OIL,
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
    category.parentId === CategoryAnchor.OTHER ||
    // The three composition categories: their listings' codes come from the
    // oilType this table derives, so empty fiscal columns are correct there.
    // TRANSMISSION_OIL is deliberately excluded — it denotes no composition, so
    // it must carry its OWN MXIK and is reported as a gap until it has one.
    oilTypeForCategory(category.id) !== null
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
 * The ROOT (level-0) node {@link CategoryAnchor.ANTIFREEZE} hangs under, so the
 * (vehicleCategoryId, categoryId) pair the wizard writes passes the server-side
 * lineage check. Derived from the enum→slug table rather than spelled out, so it
 * cannot drift from the tree the seed builds.
 */
export const ANTIFREEZE_ROOT_ID: string =
  VEHICLE_CATEGORY_TO_SLUG[PartVehicleCategory.MAINTENANCE_AND_FLUIDS];

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

/**
 * PartCategory id → the home-grid bucket for that node and, unless a node below
 * it decides otherwise, its whole subtree.
 *
 * WHY THIS EXISTS. A part carries two independent classifications: the node it
 * is FILED on (`categoryId`, anywhere in the tree) and its home-grid bucket
 * (`mainCategory`). Only the second feeds the home grid — both
 * `GET /v1/categories` counts and the `?category=<bucket>` listing roll up by
 * `mainCategory`. A part filed on a subcategory that nothing ever bucketed has
 * `mainCategory = null` and is invisible to every tile, reachable only by
 * drilling the exact subcategory id. The Driver's Village classification import
 * buckets a position only when it is filed on a bucket row itself, so its parts
 * on real subcategories ('front-brake-pads', 'air-filters', …) all ended up
 * there and the home grid listed nothing but the oils.
 *
 * HOW IT IS READ — see mainCategoryForCategory. The NEAREST decision wins,
 * walking from the node toward its root: a bucket row is its own bucket (via
 * MAIN_CATEGORY_BY_SLUG, so the 12 rows are not repeated here), then an entry
 * here, then CATEGORIES_WITHOUT_MAIN_CATEGORY (explicitly none). A root entry is
 * therefore only a FALLBACK: a more specific entry beneath it always wins.
 *
 * Consulted only when no bucket was ASSIGNED. A stored mainCategory — the
 * Telegram classifier's, an operator's — is never overridden by this table.
 *
 * DELIBERATELY PARTIAL. A node earns an entry only when every part filed on it
 * (and, for a root, beneath it) belongs to that one bucket; what has no bucket
 * among the 12 is listed in CATEGORIES_WITHOUT_MAIN_CATEGORY instead of being
 * guessed. A change here re-buckets unclassified parts on their next
 * projection; rows already in the database move only through
 * `npm run backfill:root-buckets`, whose dry-run lists every row it would fill.
 */
export const CATEGORY_ID_TO_MAIN_CATEGORY: Readonly<
  Record<string, PartMainCategory>
> = {
  // ── Roots whose every node belongs to one bucket (subtree fallback) ────────
  'brake-system': PartMainCategory.BRAKES,
  'suspension-and-steering': PartMainCategory.SUSPENSION,
  // Motor, transmission and every composition oil.
  [CategoryAnchor.MOTOR_OIL]: PartMainCategory.OIL_AND_FLUIDS,

  // ── maintenance-and-fluids spans FILTERS and OIL_AND_FLUIDS, so it has no
  //    root entry: each subcategory is decided on its own ─────────────────────
  'oil-filters': PartMainCategory.FILTERS,
  'air-filters': PartMainCategory.FILTERS,
  'cabin-filters': PartMainCategory.FILTERS,
  'fuel-filters': PartMainCategory.FILTERS,
  [CategoryAnchor.ANTIFREEZE]: PartMainCategory.OIL_AND_FLUIDS,
  'technical-fluids': PartMainCategory.OIL_AND_FLUIDS,

  // ── electrical-and-lighting spans IGNITION, ELECTRICAL_PARTS and LIGHTING ──
  'spark-plugs': PartMainCategory.IGNITION,
  'ignition-coils-wires': PartMainCategory.IGNITION,
  alternators: PartMainCategory.ELECTRICAL_PARTS,
  starters: PartMainCategory.ELECTRICAL_PARTS,
  'engine-sensors': PartMainCategory.ELECTRICAL_PARTS,
  // Admin-created in production, hence absent from the subcategory seed.
  'tire-pressure-sensors': PartMainCategory.ELECTRICAL_PARTS,
  'headlights-and-bulbs': PartMainCategory.LIGHTING,

  // ── engine-system spans ENGINE and BELTS_AND_HOSES. No root entry either: a
  //    node an admin adds under it is then reported by the backfill instead of
  //    landing in ENGINE unreviewed. The belts are decided first, the engine
  //    internals after them. ───────────────────────────────────────────────────
  'timing-belt-kits': PartMainCategory.BELTS_AND_HOSES,
  'accessory-drive-belts': PartMainCategory.BELTS_AND_HOSES,
  'gaskets-and-seals': PartMainCategory.ENGINE,
  'piston-group': PartMainCategory.ENGINE,
  'valves-and-cylinder-head': PartMainCategory.ENGINE,
  'engine-mounts': PartMainCategory.ENGINE,

  // ── tuning-and-accessories also holds interior goods, so only its exterior
  //    body accessories — the root the EXTERIOR bucket row itself hangs under ─
  'skid-plates': PartMainCategory.EXTERIOR,
  'wind-deflectors-mudflaps': PartMainCategory.EXTERIOR,

  // Matched by id wherever it hangs: the seed files it under
  // 'cat_uncategorized', production under 'other'.
  'wiper-blades': PartMainCategory.WIPERS,
};

/**
 * Tree nodes with NO home-grid bucket among the 12, kept unbucketed on purpose
 * rather than forced into the nearest-sounding one: a part filed on one keeps
 * `mainCategory = null` and stays reachable through the subcategory drill and
 * search. Being listed is itself a decision, so it also ends the walk up the
 * tree — a root fallback added later cannot capture these.
 *
 * Moving a node out of here is a product decision: either an existing bucket it
 * genuinely belongs to, or a new home tile (a new PartMainCategory value).
 */
export const CATEGORIES_WITHOUT_MAIN_CATEGORY: ReadonlySet<string> = new Set([
  // Transmission — no transmission bucket among the 12.
  'transmission',
  'clutch-kits',
  'cv-joints-driveshafts',
  'cv-joint-boots',
  'flywheels',
  'gear-linkages-cables',
  // Heating & cooling — no cooling or climate bucket among the 12.
  'heating-and-cooling',
  'cooling-radiators',
  'heater-cores',
  'water-pumps',
  'thermostats',
  'coolant-hoses-tanks',
  'cooling-fans',
  // Interior accessories — EXTERIOR is the only bucket under their root.
  'floor-mats',
  'seat-covers',
  // "Другое": non-vehicle oils and goods, pending a decision.
  CategoryAnchor.OTHER,
  'industrial-oil',
  'motorcycle-oil',
  'agricultural-machinery',
  'other-lubricants',
  'fasteners-and-clips',
  // Roots spanning several buckets: a part filed on the root itself has none.
  'maintenance-and-fluids',
  'electrical-and-lighting',
  'engine-system',
  'tuning-and-accessories',
  // The projection's fallback for a product nothing classified.
  'cat_uncategorized',
]);

/** The two tables mainCategoryForCategory reads; injectable for tests. */
export interface MainCategoryRules {
  byCategoryId: Readonly<Record<string, PartMainCategory>>;
  withoutMainCategory: ReadonlySet<string>;
}

export const MAIN_CATEGORY_RULES: MainCategoryRules = {
  byCategoryId: CATEGORY_ID_TO_MAIN_CATEGORY,
  withoutMainCategory: CATEGORIES_WITHOUT_MAIN_CATEGORY,
};

/** `categoryId → parentId` for the tree rows mainCategoryForCategory walks. */
export function categoryParentMap(
  rows: readonly { id: string; parentId: string | null }[],
): Map<string, string | null> {
  return new Map(rows.map((r) => [r.id, r.parentId]));
}

/**
 * What one node itself decides: a bucket, `null` (explicitly none) or
 * `undefined` (no decision — ask its parent). Own-property lookups only, so an
 * id such as 'constructor' cannot inherit a value off Object.prototype.
 */
function ownMainCategory(
  categoryId: string,
  rules: MainCategoryRules,
): PartMainCategory | null | undefined {
  const bucketRow = MAIN_CATEGORY_BY_SLUG.get(categoryId);
  if (bucketRow) return bucketRow;
  if (Object.prototype.hasOwnProperty.call(rules.byCategoryId, categoryId)) {
    return rules.byCategoryId[categoryId];
  }
  if (rules.withoutMainCategory.has(categoryId)) return null;
  return undefined;
}

/**
 * The home-grid bucket a part filed on `categoryId` rolls up to, or null when
 * the tree gives it none. Walks from the node toward its root and returns the
 * FIRST decision (see CATEGORY_ID_TO_MAIN_CATEGORY); a node `parentOf` does not
 * know ends the walk. The single rule shared by the projection and the
 * backfill, so the two can never disagree.
 *
 * Bounded by the size of `parentOf`, so a malformed cycle (which the schema
 * permits but the admin UI does not create) terminates instead of spinning.
 */
export function mainCategoryForCategory(
  categoryId: string,
  parentOf: ReadonlyMap<string, string | null>,
  rules: MainCategoryRules = MAIN_CATEGORY_RULES,
): PartMainCategory | null {
  let cursor: string | null | undefined = categoryId;
  for (let hops = 0; cursor && hops <= parentOf.size; hops += 1) {
    const decision = ownMainCategory(cursor, rules);
    if (decision !== undefined) return decision;
    cursor = parentOf.get(cursor);
  }
  return null;
}

/**
 * The vehicle system a part filed on `categoryId` belongs to: the enum its ROOT
 * mirrors (VEHICLE_CATEGORY_BY_SLUG), the same pairing the seller bot and the
 * classification import write. Null when the root mirrors none ('other',
 * 'cat_uncategorized', an admin-created root), when `parentOf` does not know a
 * node on the way, or on a malformed cycle.
 */
export function vehicleCategoryForCategory(
  categoryId: string,
  parentOf: ReadonlyMap<string, string | null>,
): PartVehicleCategory | null {
  let cursor = categoryId;
  for (let hops = 0; hops <= parentOf.size; hops += 1) {
    const parent = parentOf.get(cursor);
    if (parent === undefined) return null;
    if (parent === null) return VEHICLE_CATEGORY_BY_SLUG.get(cursor) ?? null;
    cursor = parent;
  }
  return null;
}
