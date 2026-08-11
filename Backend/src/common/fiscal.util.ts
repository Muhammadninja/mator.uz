import { OilType, PackageForm } from '@prisma/client';

/**
 * The ONE place the fiscal-data rules live: what a valid MXIK / package code
 * looks like, when a category counts as configured, and which of its two
 * package codes fiscalizes a given listing.
 *
 * Three very different consumers read these rules — the admin console (write
 * validation), the Telegram seller bot (whether to ask the sale-form question)
 * and the Payme receipt builder (which code to send) — so they are defined here
 * once rather than re-derived per consumer, exactly like the category-tree
 * rules in PartCategoryService and the kind capabilities in product-kind.ts.
 *
 * Ownership, which nothing here may blur:
 *   Category → mxik + packageCodeSingle + packageCodeSet
 *   Dealer   → tin + vatPercent
 *   Product  → the sale FORM only (which code, never the code itself)
 */

/**
 * MXIK / ИКПУ: exactly 17 digits (e.g. 08708005011000000). Leading zeros are
 * significant, which is why it is stored and validated as a string.
 */
export const MXIK_PATTERN = /^\d{17}$/;

/**
 * A Tasnif package code, as issued by tasnif.soliq.uz (e.g. 1417722). Digits
 * only; the length is not fixed by the registry, so only the shape and the
 * column bound (VarChar(20)) are enforced.
 */
export const PACKAGE_CODE_PATTERN = /^\d{1,20}$/;

/**
 * A dealer's tax id: a 9-digit ИНН (legal entity) or a 14-digit ПИНФЛ
 * (individual). Both are strings — never numbers — because leading zeros carry
 * meaning.
 */
export const TIN_PATTERN = /^(\d{9}|\d{14})$/;

/** VAT rate bounds for the admin-entered percentage (0 and 12 are the usual). */
export const MIN_VAT_PERCENT = 0;
export const MAX_VAT_PERCENT = 100;

/** The fiscal columns of a category, as every consumer reads them. */
export interface CategoryFiscalData {
  mxik: string | null;
  packageCodeSingle: string | null;
  packageCodeSet: string | null;
}

/** One resolved (MXIK, package code) pair, whatever it was derived from. */
export interface FiscalCodes {
  mxik: string;
  packageCode: string;
}

/**
 * Motor oil is classified by its BASE COMPOSITION, not by its category: the
 * registry issues a different MXIK and package code for synthetic,
 * semi-synthetic and mineral oil, while the catalog holds them all under one
 * category ("Моторные масла" and the "Другое" oil children).
 *
 * So an oil listing's codes come from `Product.oilType` — the answer the seller
 * gave at the OIL_TYPE step — rather than from its category's columns. This is
 * the ONLY place a listing's own attribute supplies fiscal codes, and it exists
 * because the taxonomy genuinely differs from the classifier's, not as a way to
 * put fiscal data on products: nothing is stored per product, the oil type was
 * already there, and this table is shared by every consumer.
 */
export const OIL_TYPE_FISCAL: Readonly<Record<OilType, FiscalCodes>> = {
  [OilType.SYNTHETIC]: {
    mxik: '02710005001000000',
    packageCode: '1282037',
  },
  [OilType.SEMI_SYNTHETIC]: {
    mxik: '02710005002000000',
    packageCode: '1282031',
  },
  [OilType.MINERAL]: {
    mxik: '02710005003000000',
    packageCode: '1282581',
  },
};

/**
 * The reason an oil listing cannot be fiscalized: the seller's oil type is
 * missing, so there is no way to tell synthetic from mineral — and the three
 * carry different codes, so no substitute is honest.
 */
export const OIL_TYPE_REQUIRED = 'Oil type required for fiscal configuration';

/**
 * The codes for a motor-oil listing, from its own oil type. Null when the
 * listing carries no oil type, which the caller must report as a gap
 * ({@link OIL_TYPE_REQUIRED}) rather than fall back to the category: the
 * category has no codes precisely because they depend on this attribute.
 */
export function resolveOilFiscalCodes(
  oilType: OilType | null | undefined,
): FiscalCodes | null {
  if (!oilType) return null;
  return OIL_TYPE_FISCAL[oilType] ?? null;
}

/**
 * Whether a category is fiscally CONFIGURED — i.e. a product in it can be sold
 * online at all. Both an MXIK and a single package code are required; the set
 * code is optional and never makes a category configured on its own.
 */
export function isCategoryFiscallyConfigured(
  category: CategoryFiscalData,
): boolean {
  return !!category.mxik && !!category.packageCodeSingle;
}

/**
 * Whether the seller must be ASKED how the item is sold. True only when the
 * category genuinely offers a choice — both codes present. A category with one
 * package code has nothing to ask about, so the wizard never shows the step and
 * the single code applies automatically.
 */
export function offersPackageChoice(
  category: Pick<CategoryFiscalData, 'packageCodeSingle' | 'packageCodeSet'>,
): boolean {
  return !!category.packageCodeSingle && !!category.packageCodeSet;
}

/**
 * The Tasnif package code that fiscalizes a listing: the SET code when the
 * seller chose "Комплект / набор", else the single code.
 *
 * `form` is null for every listing whose category offered no choice — the
 * question was never asked — and the single code is then the answer. A SET
 * choice whose code has since been removed by an admin falls back to the single
 * code rather than fiscalizing with nothing; returns null only when the category
 * carries no usable code at all, which the caller must treat as an error.
 */
export function resolvePackageCode(
  category: Pick<CategoryFiscalData, 'packageCodeSingle' | 'packageCodeSet'>,
  form: PackageForm | null | undefined,
): string | null {
  if (form === PackageForm.SET && category.packageCodeSet) {
    return category.packageCodeSet;
  }
  return category.packageCodeSingle ?? null;
}
