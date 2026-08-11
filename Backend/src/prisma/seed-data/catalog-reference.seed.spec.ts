// Guards the initial category fiscal configuration: every seeded code is
// well-formed, points at a category that actually exists in the tree, and lands
// on a LEAF (the node a seller's listing can end on). Also pins the two
// deliberate absences — the oil categories, whose supplied codes are per oil
// TYPE and cannot be attached to a single category, and every category the
// supplied list does not describe.

import {
  CATEGORY_FISCAL_DATA,
  fiscalDataFor,
  SEED_CATEGORIES,
  SEED_OTHER_CATEGORIES,
  SEED_ROOT_CATEGORIES,
} from './catalog-reference.seed';
import {
  MXIK_PATTERN,
  PACKAGE_CODE_PATTERN,
  isCategoryFiscallyConfigured,
} from '../../common/fiscal.util';
import { isFiscalizedByOilType } from '../../catalog/categories/category-map';

/** Every category id the seed creates. */
const SEEDED_IDS = new Set<string>([
  ...SEED_ROOT_CATEGORIES.map((c) => c.id),
  ...SEED_CATEGORIES.map((c) => c.id),
  ...SEED_OTHER_CATEGORIES.map((c) => c.id),
]);

/** Ids that are a PARENT of something — a seller never lands on one of these. */
const PARENT_IDS = new Set<string>([
  ...SEED_CATEGORIES.map((c) => c.parentId),
  ...SEED_OTHER_CATEGORIES.map(() => 'other'),
]);

describe('CATEGORY_FISCAL_DATA', () => {
  const entries = Object.entries(CATEGORY_FISCAL_DATA);

  it('configures a category only if it exists in the seeded tree', () => {
    for (const [id] of entries) {
      expect(SEEDED_IDS.has(id)).toBe(true);
    }
  });

  it('configures LEAVES only — a parent’s codes would be unreachable', () => {
    // A listing always lands on a leaf: selectCategory keeps the root only when
    // that root has no children. So 'brakes' carries the brake codes, not the
    // 'brake-system' root above it.
    for (const [id] of entries) {
      expect(PARENT_IDS.has(id)).toBe(false);
    }
    expect(Object.keys(CATEGORY_FISCAL_DATA)).toContain('brakes');
    expect(Object.keys(CATEGORY_FISCAL_DATA)).not.toContain('brake-system');
  });

  it('carries a well-formed MXIK and package codes everywhere', () => {
    for (const [id, fiscal] of entries) {
      // The id is folded into the assertion so a failure names the category.
      expect({ id, valid: MXIK_PATTERN.test(fiscal.mxik) }).toEqual({
        id,
        valid: true,
      });
      expect(PACKAGE_CODE_PATTERN.test(fiscal.packageCodeSingle)).toBe(true);
      if (fiscal.packageCodeSet !== undefined) {
        expect(PACKAGE_CODE_PATTERN.test(fiscal.packageCodeSet)).toBe(true);
        // The two forms must be DIFFERENT codes, or the choice is meaningless.
        expect(fiscal.packageCodeSet).not.toBe(fiscal.packageCodeSingle);
      }
    }
  });

  it('leaves every entry fiscally complete by the shared rule', () => {
    for (const [, fiscal] of entries) {
      expect(
        isCategoryFiscallyConfigured({
          mxik: fiscal.mxik,
          packageCodeSingle: fiscal.packageCodeSingle,
          packageCodeSet: fiscal.packageCodeSet ?? null,
        }),
      ).toBe(true);
    }
  });

  it('gives the three set-bearing categories both codes, and no others', () => {
    const withSet = entries
      .filter(([, f]) => f.packageCodeSet)
      .map(([id]) => id)
      .sort();
    expect(withSet).toEqual(['brakes', 'suspension', 'transmission']);
  });

  it('never reuses an MXIK across two categories', () => {
    const codes = entries.map(([, f]) => f.mxik);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('stores NO codes on the oil categories — they resolve per oil type', () => {
    // The supplied list gives three MXIKs (synthetic / semi-synthetic /
    // mineral) because oil is classified by base composition. That is a listing
    // attribute here, not a category, so the codes live in OIL_TYPE_FISCAL and
    // the category deliberately carries none.
    expect(fiscalDataFor('motor-oil')).toEqual({});
    expect(fiscalDataFor('motorcycle-oil')).toEqual({});
  });

  it('still counts the oil categories as fiscally COMPLETE', () => {
    // Empty columns are not a gap here: every listing of these categories is
    // fiscalized from its oil type, so the console must not report them as
    // unconfigured or prompt for codes that would be ignored.
    expect(isFiscalizedByOilType({ id: 'motor-oil', parentId: null })).toBe(
      true,
    );
    for (const child of SEED_OTHER_CATEGORIES) {
      expect(isFiscalizedByOilType({ id: child.id, parentId: 'other' })).toBe(
        true,
      );
    }
  });

  it('leaves the SPARE-PART oil leaf on the category path', () => {
    // 'oil-and-fluids' hangs under maintenance-and-fluids and runs the ordinary
    // spare-part questionnaire — no oil type is ever collected — so it needs
    // real codes and the supplied list does not describe it.
    expect(fiscalDataFor('oil-and-fluids')).toEqual({});
    expect(
      isFiscalizedByOilType({
        id: 'oil-and-fluids',
        parentId: 'maintenance-and-fluids',
      }),
    ).toBe(false);
  });

  it('leaves any category the supplied list does not describe untouched', () => {
    // Returning {} is what stops a re-seed from CLEARING values an operator
    // entered by hand for such a category.
    expect(fiscalDataFor('industrial-oil')).toEqual({});
    expect(fiscalDataFor('cat_uncategorized')).toEqual({});
    expect(fiscalDataFor('constructor')).toEqual({});
  });

  it('writes an explicit null set code for a single-form category', () => {
    expect(fiscalDataFor('filters')).toEqual({
      mxik: '08421002001000000',
      packageCodeSingle: '1499205',
      packageCodeSet: null,
    });
  });
});
