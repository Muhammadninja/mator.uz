// src/catalog/categories/legacy-viscosity-categories.ts
//
// The RETIRED viscosity categories: PartCategory rows whose only meaning was a
// motor-oil SAE grade ("Масло 5W-30"). Viscosity is an ATTRIBUTE of a listing
// (Product.oilViscosity), never a place in the taxonomy, so these nodes are
// removed from the tree and the grade they encoded is moved onto the column.
//
// Kept as data — and in `catalog/` rather than in the migration script — because
// three things must agree on exactly this set and must not drift:
//   • the data migration that empties and drops the rows,
//   • the seed, which must stop creating them,
//   • the tests that assert the tree no longer carries a viscosity.
//
// `transmission-oil` is deliberately NOT here. It is a genuine category (a
// product type, not a grade) and it stays in the tree.

/**
 * Retired category id → the viscosity it stood for, in the catalog's canonical
 * display form (see OIL_VISCOSITIES in telegram/motor-oil-catalog.ts).
 *
 * The grade is recorded here so the migration can move a real value onto
 * `oilViscosity` instead of discarding it: a part filed under "Масло 5W-30" is
 * evidence of its grade, and that is the ONLY inference made. Nothing else about
 * such a listing (its oil TYPE above all — synthetic vs mineral, which decides
 * the MXIK) is guessed: a grade does not imply a base composition.
 */
export const LEGACY_VISCOSITY_CATEGORIES: Readonly<Record<string, string>> = {
  'motor-oil-5w30': '5W-30',
  'motor-oil-5w40': '5W-40',
  'motor-oil-10w40': '10W-40',
};

/** The retired ids alone, for `in` queries and tree assertions. */
export const LEGACY_VISCOSITY_CATEGORY_IDS: readonly string[] = Object.keys(
  LEGACY_VISCOSITY_CATEGORIES,
);

/** Whether a category id is a retired viscosity node. */
export function isLegacyViscosityCategory(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    LEGACY_VISCOSITY_CATEGORIES,
    id,
  ) as boolean;
}
