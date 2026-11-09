import { OilType, PackageForm, Prisma, ProductKind } from '@prisma/client';
import {
  CategoryAnchor,
  UNCATEGORIZED_CATEGORY_ID,
  isFiscalizedByOilType,
  kindFitsCategory,
  listingTypeForCategory,
  oilTypeForCategory,
} from '../catalog/categories/category-map';

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
 *   Category → mxik + a package code per sale form
 *   Dealer   → tin + vatPercent
 *   Product  → the sale FORM only (which code, never the code itself)
 *
 * What a listing's receipt line may carry is decided in exactly one place,
 * {@link resolveFiscalClassification}. The Payme receipt and every readiness flag
 * the console shows go through it, so they cannot disagree.
 */

/**
 * MXIK / ИКПУ: exactly 17 digits (e.g. 08708005011000000). Leading zeros are
 * significant, which is why it is stored and validated as a string.
 */
export const MXIK_PATTERN = /^\d{17}$/;

/**
 * A Tasnif package code, as issued by tasnif.soliq.uz (e.g. 1417722), sent to Payme as
 * `package_code`. Digits only; the length is not fixed by the registry, so only the
 * shape and the column bound (VarChar(20)) are enforced.
 *
 * Tasnif issues these PER MXIK, so a code means something only next to its own: "штука"
 * is 1417722 on brakes and 1417728 on the steering mechanism. No code is universal, and
 * none may be copied from one category to another.
 */
export const PACKAGE_CODE_PATTERN = /^\d{1,20}$/;

/**
 * A dealer's tax id: a 9-digit ИНН (legal entity) or a 14-digit ПИНФЛ
 * (individual). Both are strings — never numbers — because leading zeros carry
 * meaning.
 */
export const TIN_PATTERN = /^(\d{9}|\d{14})$/;

/**
 * VAT rate bounds for the admin-entered percentage. Any rate in between is accepted, as
 * the operator states it per dealer (0 and 12 are the usual, 4 or 6 occur too).
 *
 * A rate is what the receipt says about the seller, never part of a price: a catalog price
 * already includes VAT, and nothing multiplies or divides one by a rate.
 */
export const MIN_VAT_PERCENT = 0;
export const MAX_VAT_PERCENT = 100;

/** The fiscal columns of a category, as every consumer reads them. */
export interface CategoryFiscalData {
  mxik: string | null;
  packageCodeSingle: string | null;
  packageCodeSet: string | null;
  packageCodeBox: string | null;
}

/**
 * How a listing is sold → the category column holding its package code. The ONE mapping
 * between the two, and nothing else decides which code a form gets. It names a column
 * rather than a code because the codes differ per MXIK (see PACKAGE_CODE_PATTERN).
 */
export const PACKAGE_CODE_COLUMN = {
  [PackageForm.SINGLE]: 'packageCodeSingle',
  [PackageForm.SET]: 'packageCodeSet',
  [PackageForm.BOX]: 'packageCodeBox',
} as const satisfies Record<PackageForm, keyof CategoryFiscalData>;

type CategoryPackageCodeColumns = Pick<
  CategoryFiscalData,
  (typeof PACKAGE_CODE_COLUMN)[PackageForm]
>;

/** The sale forms in the order a seller is asked about them. */
const PACKAGE_FORMS = [
  PackageForm.SINGLE,
  PackageForm.SET,
  PackageForm.BOX,
] as const;

/** One resolved (MXIK, package code) pair, whatever it was derived from. */
export interface FiscalCodes {
  mxik: string;
  packageCode: string;
}

/**
 * Motor oil is classified by its BASE COMPOSITION: the registry issues a different
 * MXIK and package code for synthetic, semi-synthetic and mineral oil, and the
 * catalog files each on a composition category of its own under "Моторные масла".
 *
 * These codes apply only to a MOTOR_OIL listing on the composition category that
 * states the same oil type (see {@link resolveFiscalClassification}), and only while
 * that category has no MXIK of its own: an operator's code wins over this table. An
 * oil type on anything else, such as an industrial oil under "Другое", does not make
 * it motor oil. Nothing is stored per product and this table is shared by every
 * consumer.
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
 * The table's entry for an oil type, or null for none. A lookup, not a decision:
 * whether these codes apply to a given listing is for
 * {@link resolveFiscalClassification}.
 */
export function resolveOilFiscalCodes(
  oilType: OilType | null | undefined,
): FiscalCodes | null {
  if (!oilType) return null;
  return OIL_TYPE_FISCAL[oilType] ?? null;
}

/**
 * Whether a category is fiscally CONFIGURED — i.e. a product in it can be sold
 * online at all. Both an MXIK and a single package code are required; the set and
 * box codes are optional and never make a category configured on their own.
 */
export function isCategoryFiscallyConfigured(
  category: CategoryFiscalData,
): boolean {
  return !!category.mxik && !!category.packageCodeSingle;
}

/** The sale forms this category holds a code for, in the order a seller is asked. */
export function offeredPackageForms(
  category: CategoryPackageCodeColumns,
): PackageForm[] {
  return PACKAGE_FORMS.filter((form) => !!category[PACKAGE_CODE_COLUMN[form]]);
}

/**
 * Whether the seller must be ASKED how the item is sold. True only when the
 * category genuinely offers a choice, with more than one code. A category with one
 * package code has nothing to ask about, so the wizard never shows the step.
 */
export function offersPackageChoice(
  category: CategoryPackageCodeColumns,
): boolean {
  return offeredPackageForms(category).length > 1;
}

/**
 * The Tasnif package code that fiscalizes a listing, or null when there is none. Null
 * is an answer the caller must treat as a refusal: nothing stands in for a missing
 * code, least of all "штука", which on a set or a box would misstate what was sold.
 *
 *   • A stated form gets the code of that form, and only that.
 *   • A listing that states nothing gets the single code only where the category holds
 *     nothing else: a category with one code says everything there is sold that way.
 *     With more than one code, someone has to say which applies.
 */
export function resolvePackageCode(
  category: CategoryPackageCodeColumns,
  form: PackageForm | null | undefined,
): string | null {
  if (form) return category[PACKAGE_CODE_COLUMN[form]] ?? null;
  const offered = offeredPackageForms(category);
  return offered.length === 1 && offered[0] === PackageForm.SINGLE
    ? category.packageCodeSingle
    : null;
}

/** A listing states no sale form, on a category holding more than one code. */
export const PACKAGE_FORM_NOT_STATED =
  'the listing does not state how it is sold, and its category holds more than one package code';

/**
 * What is wrong with this sale form on this category, or null. Says nothing about a
 * category with no codes at all, which is a gap of its own. The oil table holds one
 * code per composition, for oil sold the way that code says, so it has none for
 * anything else.
 */
export function packageFormGap(
  category: Pick<FiscalCategorySource, 'id' | keyof CategoryFiscalData>,
  form: PackageForm | null | undefined,
): string | null {
  const noCode = (stated: PackageForm) =>
    `category "${category.id}" has no package code for a listing sold as ${stated}`;
  if (isFiscalizedByOilType(category)) {
    return form && form !== PackageForm.SINGLE ? noCode(form) : null;
  }
  if (form) return category[PACKAGE_CODE_COLUMN[form]] ? null : noCode(form);
  return offersPackageChoice(category) ? PACKAGE_FORM_NOT_STATED : null;
}

// ── The classification resolver ──────────────────────────────────────────────

/**
 * What every fiscal reader selects of a category. `_count.children` counts ACTIVE
 * children only, the same ones the seller bot offers: a node with none is a leaf.
 */
export const FISCAL_CATEGORY_SELECT = {
  id: true,
  parentId: true,
  mxik: true,
  packageCodeSingle: true,
  packageCodeSet: true,
  packageCodeBox: true,
  _count: { select: { children: { where: { isActive: true } } } },
} satisfies Prisma.PartCategorySelect;

export interface FiscalCategorySource extends CategoryFiscalData {
  id: string;
  parentId: string | null;
  _count: { children: number };
}

export interface FiscalClassificationInput {
  kind: ProductKind;
  oilType: OilType | null;
  packageForm: PackageForm | null;
  /** The category the listing is filed on, or null when it is unknown. */
  category: FiscalCategorySource | null;
}

export type FiscalClassification =
  | { ok: true; mxik: string; packageCode: string }
  | { ok: false; gaps: string[] };

/**
 * Codes supplied for ONE product of a node that holds many kinds of goods: a starter
 * on `electrical-parts`, a headlight on `lighting`, a spark plug on `ignition`, rubber
 * hoses on `belts-and-hoses`. A migration (20260811000000) and the seed both put them
 * there. None of the four has children in the seeded tree, because the subcategories
 * for those goods are its SIBLINGS, so the rule about parents would not catch them,
 * and new listings can land on them by themselves (see classificationOf). A node
 * still holding its code is therefore treated like a parent: nothing is sold from it.
 * A different code entered by an operator is a decision this table says nothing about.
 */
export const REPRESENTATIVE_ONLY_MXIK: Readonly<Record<string, string>> = {
  'electrical-parts': '08511001001000000',
  lighting: '08512001010000000',
  ignition: '08511001002000000',
  'belts-and-hoses': '04009001012000000',
};

function holdsRepresentativeCode(category: {
  id: string;
  mxik: string | null;
}): boolean {
  return REPRESENTATIVE_ONLY_MXIK[category.id] === category.mxik;
}

/**
 * Whether a listing on this category would have codes to carry: its own, or on a
 * composition category with none of its own, those of OIL_TYPE_FISCAL.
 */
export function hasUsableFiscalCodes(
  category: Pick<FiscalCategorySource, 'id' | keyof CategoryFiscalData>,
): boolean {
  if (isFiscalizedByOilType(category)) return true;
  return (
    isCategoryFiscallyConfigured(category) && !holdsRepresentativeCode(category)
  );
}

/**
 * THE decision on what a listing's receipt line may carry: the MXIK and package code,
 * or every reason there are none. Used by the Payme receipt and by every readiness
 * flag the console shows, so the two can never disagree.
 *
 * A non-empty `mxik` is not enough, because having a code is not the same as having
 * the right one:
 *   • the code must be the category's OWN. A parent's code is never inherited, and a
 *     node with children is too broad to classify what sits on it;
 *   • the kind must belong on the category (see kindFitsCategory).
 *
 * An oil type alone never supplies a code: the oil table needs a MOTOR_OIL listing on
 * the composition category stating that same type, with no code of its own. Every
 * other listing, transmission oil included, reads its own category's columns.
 */
export function resolveFiscalClassification(
  input: FiscalClassificationInput,
): FiscalClassification {
  const { kind, oilType, packageForm, category } = input;
  if (!category) {
    return { ok: false, gaps: ['category fiscal data is unavailable'] };
  }
  if (category.id === UNCATEGORIZED_CATEGORY_ID) {
    return { ok: false, gaps: ['listing is not classified yet'] };
  }
  const composition = oilTypeForCategory(category.id);
  const byOilTable = isFiscalizedByOilType(category);
  // The oil table describes motor oil and nothing else, but a code an operator entered
  // on a composition applies to everything filed there. That includes a position
  // filed by hand that an import left as SPARE_PART, because 1C does not state a kind.
  const untypedOnOwnCodes =
    composition !== null && !byOilTable && kind === ProductKind.SPARE_PART;
  if (!untypedOnOwnCodes && !kindFitsCategory(kind, category)) {
    return {
      ok: false,
      gaps: [`a ${kind} listing does not belong on category "${category.id}"`],
    };
  }

  const gaps: string[] = [];
  if (category._count.children > 0) {
    gaps.push(
      `category "${category.id}" has subcategories: file the listing on one of them`,
    );
  }
  if (composition && oilType && oilType !== composition) {
    gaps.push(`oil type ${oilType} contradicts category "${category.id}"`);
  }

  let codes: FiscalCodes | null = null;
  if (composition && byOilTable) {
    if (!oilType) gaps.push(OIL_TYPE_REQUIRED);
    else codes = resolveOilFiscalCodes(composition);
    const formGap = packageFormGap(category, packageForm);
    if (formGap) gaps.push(formGap);
  } else if (
    kind === ProductKind.MOTOR_OIL &&
    category.id === CategoryAnchor.MOTOR_OIL
  ) {
    gaps.push(OIL_TYPE_REQUIRED);
  } else {
    const packageCode = resolvePackageCode(category, packageForm);
    if (holdsRepresentativeCode(category)) {
      gaps.push(
        `the code on category "${category.id}" describes one product of what it holds: file the listing on a subcategory, or enter a code true of all of it`,
      );
    }
    if (!category.mxik) gaps.push('category has no MXIK');
    else if (!MXIK_PATTERN.test(category.mxik)) {
      gaps.push(`category MXIK "${category.mxik}" is malformed`);
    }
    // A set code alone never makes a category configured, even for a listing sold
    // as a set: see isCategoryFiscallyConfigured.
    const formGap = packageFormGap(category, packageForm);
    if (!category.packageCodeSingle) {
      gaps.push('category has no package code');
    } else if (formGap) {
      gaps.push(formGap);
    } else if (packageCode && !PACKAGE_CODE_PATTERN.test(packageCode)) {
      gaps.push(`category package code "${packageCode}" is malformed`);
    }
    if (category.mxik && packageCode) {
      codes = { mxik: category.mxik, packageCode };
    }
  }

  if (gaps.length > 0 || !codes) return { ok: false, gaps };
  return { ok: true, mxik: codes.mxik, packageCode: codes.packageCode };
}

/**
 * Everything wrong with a dealer's tax data. A rate of 0 is a rate, not a gap. The
 * formats are the ones the admin API enforces, checked again here because this is
 * the last stop before a receipt and a row can reach the table some other way.
 */
export function dealerFiscalGaps(
  dealer: { tin: string | null; vatPercent: unknown } | null,
): string[] {
  if (!dealer) return ['dealer is unavailable'];
  const gaps: string[] = [];
  if (!dealer.tin) gaps.push('dealer has no TIN');
  else if (!TIN_PATTERN.test(dealer.tin)) gaps.push('dealer TIN is malformed');
  if (dealer.vatPercent == null) {
    gaps.push('dealer has no VAT percentage');
  } else {
    const rate = Number(dealer.vatPercent);
    if (!(rate >= MIN_VAT_PERCENT && rate <= MAX_VAT_PERCENT)) {
      gaps.push('dealer VAT percentage is out of range');
    }
  }
  return gaps;
}

/** Why a listing cannot be fiscalized; empty when it can. The Payme gate's own rule. */
export function listingFiscalGaps(
  listing: FiscalClassificationInput & {
    dealer: { tin: string | null; vatPercent: unknown } | null;
  },
): string[] {
  const classification = resolveFiscalClassification(listing);
  return [
    ...(classification.ok ? [] : classification.gaps),
    ...dealerFiscalGaps(listing.dealer),
  ];
}

/** Where a category stands, for an operator working through what needs doing. */
export type CategoryFiscalStatus =
  /** Listings of the kind it holds can reach a receipt. */
  | 'READY'
  /** It needs an MXIK and package code entered. */
  | 'NEEDS_CODES'
  /**
   * Nothing should be sold from it: a parent, the unclassified bucket, or a node
   * still holding a code for one product of many (REPRESENTATIVE_ONLY_MXIK).
   */
  | 'NOT_SELLABLE';

/**
 * A category's readiness: the resolver's own answer for a listing of the kind this
 * category holds. Reporting anything else would let the console call a category ready
 * while checkout refuses what is filed on it.
 */
export function categoryFiscalReadiness(category: FiscalCategorySource): {
  status: CategoryFiscalStatus;
  gaps: string[];
} {
  const result = resolveFiscalClassification({
    ...listingTypeForCategory(category.id),
    // A question about the category, not about a listing that forgot to say how it is
    // sold: the form every configured category holds a code for.
    packageForm: PackageForm.SINGLE,
    category,
  });
  if (result.ok) return { status: 'READY', gaps: [] };
  const status: CategoryFiscalStatus =
    category.id === UNCATEGORIZED_CATEGORY_ID ||
    category._count.children > 0 ||
    holdsRepresentativeCode(category)
      ? 'NOT_SELLABLE'
      : 'NEEDS_CODES';
  return { status, gaps: result.gaps };
}
