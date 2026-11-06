// The shared fiscal rules: when a category counts as configured, when the
// seller must be asked how an item is sold, and which of a category's two
// Tasnif package codes fiscalizes a listing. Pure functions — no DB, no Nest.
//
// These are the rules the admin console, the Telegram wizard and the Payme
// receipt builder all read, so pinning them here pins all three at once.

import { OilType, PackageForm, Prisma, ProductKind } from '@prisma/client';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import {
  REPRESENTATIVE_ONLY_MXIK,
  categoryFiscalReadiness,
  confirmableFiscalCodes,
  dealerFiscalGaps,
  FISCAL_CODES_UNCONFIRMED,
  isCategoryFiscallyConfigured,
  listingFiscalGaps,
  offersPackageChoice,
  OIL_TYPE_REQUIRED,
  resolveFiscalClassification,
  resolveOilFiscalCodes,
  resolvePackageCode,
  offeredPackageForms,
  PACKAGE_CODE_COLUMN,
  PACKAGE_FORM_NOT_STATED,
  MXIK_PATTERN,
  OIL_TYPE_FISCAL,
  PACKAGE_CODE_PATTERN,
  TIN_PATTERN,
} from './fiscal.util';
import {
  decideListingMove,
  isFiscalizedByOilType,
  kindFitsCategory,
} from '../catalog/categories/category-map';
import { confirmedCategory } from '../../test/utils/harness';

/** Brakes, as supplied: sold both as a single item and as a set. */
const BOTH = {
  mxik: '08708005011000000',
  packageCodeSingle: '1417722',
  packageCodeSet: '1417723',
  packageCodeBox: null,
};

/** Filters, as supplied: one package code only. */
const SINGLE_ONLY = {
  mxik: '08421002001000000',
  packageCodeSingle: '1499205',
  packageCodeSet: null,
  packageCodeBox: null,
};

const UNCONFIGURED = {
  mxik: null,
  packageCodeSingle: null,
  packageCodeSet: null,
  packageCodeBox: null,
};

/** The steering mechanism, as Tasnif lists it on 2026-11-04: all three forms. */
const STEERING = {
  mxik: '08708001133000000',
  packageCodeSingle: '1417728',
  packageCodeSet: '1417729',
  packageCodeBox: '1533557',
};

describe('isCategoryFiscallyConfigured', () => {
  it('accepts a category with one package code', () => {
    expect(isCategoryFiscallyConfigured(SINGLE_ONLY)).toBe(true);
  });

  it('accepts a category with two package codes', () => {
    expect(isCategoryFiscallyConfigured(BOTH)).toBe(true);
  });

  it('rejects a missing MXIK', () => {
    expect(isCategoryFiscallyConfigured({ ...BOTH, mxik: null })).toBe(false);
  });

  it('rejects a missing single package code', () => {
    expect(
      isCategoryFiscallyConfigured({ ...BOTH, packageCodeSingle: null }),
    ).toBe(false);
  });

  it('does not let the OPTIONAL set code configure a category on its own', () => {
    expect(
      isCategoryFiscallyConfigured({
        mxik: BOTH.mxik,
        packageCodeSingle: null,
        packageCodeSet: BOTH.packageCodeSet,
        packageCodeBox: null,
      }),
    ).toBe(false);
  });

  it('does not let the OPTIONAL box code configure a category on its own', () => {
    expect(
      isCategoryFiscallyConfigured({
        ...STEERING,
        packageCodeSingle: null,
        packageCodeSet: null,
      }),
    ).toBe(false);
  });

  it('treats an untouched category as unconfigured', () => {
    expect(isCategoryFiscallyConfigured(UNCONFIGURED)).toBe(false);
  });
});

describe('offersPackageChoice', () => {
  it('is true only when more than one code is present', () => {
    expect(offersPackageChoice(BOTH)).toBe(true);
    expect(offersPackageChoice(STEERING)).toBe(true);
    expect(
      offersPackageChoice({ ...SINGLE_ONLY, packageCodeBox: '1493357' }),
    ).toBe(true);
    expect(offersPackageChoice(SINGLE_ONLY)).toBe(false);
    expect(offersPackageChoice(UNCONFIGURED)).toBe(false);
  });
});

describe('offeredPackageForms', () => {
  it('lists exactly the forms the category holds a code for, in asking order', () => {
    expect(offeredPackageForms(STEERING)).toEqual([
      PackageForm.SINGLE,
      PackageForm.SET,
      PackageForm.BOX,
    ]);
    expect(offeredPackageForms(BOTH)).toEqual([
      PackageForm.SINGLE,
      PackageForm.SET,
    ]);
    expect(
      offeredPackageForms({ ...SINGLE_ONLY, packageCodeBox: '1493357' }),
    ).toEqual([PackageForm.SINGLE, PackageForm.BOX]);
    expect(offeredPackageForms(UNCONFIGURED)).toEqual([]);
  });
});

describe('PACKAGE_CODE_COLUMN', () => {
  it('names a column for every sale form, so a new form cannot go unmapped', () => {
    expect(Object.keys(PACKAGE_CODE_COLUMN).sort()).toEqual(
      Object.values(PackageForm).sort(),
    );
    expect(new Set(Object.values(PACKAGE_CODE_COLUMN)).size).toBe(
      Object.values(PackageForm).length,
    );
  });
});

describe('resolvePackageCode', () => {
  it('uses the SET code when the seller chose "Комплект / набор"', () => {
    expect(resolvePackageCode(BOTH, PackageForm.SET)).toBe('1417723');
  });

  it('uses the SINGLE code when the seller chose "Штука"', () => {
    expect(resolvePackageCode(BOTH, PackageForm.SINGLE)).toBe('1417722');
  });

  it('uses the BOX code when the listing is sold in a consumer box', () => {
    expect(resolvePackageCode(STEERING, PackageForm.BOX)).toBe('1533557');
  });

  it('gives each form of the steering mechanism its own classifier code', () => {
    expect(resolvePackageCode(STEERING, PackageForm.SINGLE)).toBe('1417728');
    expect(resolvePackageCode(STEERING, PackageForm.SET)).toBe('1417729');
    expect(resolvePackageCode(STEERING, PackageForm.BOX)).toBe('1533557');
  });

  it('answers an unstated form only where the category holds one code', () => {
    // The operator who confirmed that one code said it is true of everything there.
    expect(resolvePackageCode(SINGLE_ONLY, null)).toBe('1499205');
    expect(resolvePackageCode(SINGLE_ONLY, undefined)).toBe('1499205');
  });

  it.each([
    ['a set code', BOTH],
    ['a box code', { ...SINGLE_ONLY, packageCodeBox: '1493357' }],
    ['all three codes', STEERING],
  ])('never assumes a piece for an unstated form next to %s', (_, category) => {
    expect(resolvePackageCode(category, null)).toBeNull();
    expect(resolvePackageCode(category, undefined)).toBeNull();
  });

  it('never picks the code by ORDER — the two forms are named, not positional', () => {
    // Same two codes, entered the other way round: the SET answer still yields
    // the code stored as the set code.
    const swapped = {
      packageCodeSingle: '1417723',
      packageCodeSet: '1417722',
      packageCodeBox: null,
    };
    expect(resolvePackageCode(swapped, PackageForm.SET)).toBe('1417722');
    expect(resolvePackageCode(swapped, PackageForm.SINGLE)).toBe('1417723');
  });

  it('never swaps in a piece when a stated form has no code', () => {
    // An admin removed the set code after the seller answered "Комплект", or the
    // listing moved to a category without one. Either way it is not a piece.
    expect(resolvePackageCode(SINGLE_ONLY, PackageForm.SET)).toBeNull();
    expect(resolvePackageCode(SINGLE_ONLY, PackageForm.BOX)).toBeNull();
    expect(resolvePackageCode(BOTH, PackageForm.BOX)).toBeNull();
  });

  it('returns null when the category carries no usable code at all', () => {
    expect(resolvePackageCode(UNCONFIGURED, PackageForm.SINGLE)).toBeNull();
    expect(resolvePackageCode(UNCONFIGURED, null)).toBeNull();
  });
});

// ── Motor oil ───────────────────────────────────────────────────────────────
// The registry classifies oil by BASE COMPOSITION, so one category carries
// three MXIKs and the codes come from the listing's own oil type.
describe('resolveOilFiscalCodes', () => {
  it('maps each oil type to the codes it was issued', () => {
    expect(resolveOilFiscalCodes(OilType.SYNTHETIC)).toEqual({
      mxik: '02710005001000000',
      packageCode: '1282037',
    });
    expect(resolveOilFiscalCodes(OilType.SEMI_SYNTHETIC)).toEqual({
      mxik: '02710005002000000',
      packageCode: '1282031',
    });
    expect(resolveOilFiscalCodes(OilType.MINERAL)).toEqual({
      mxik: '02710005003000000',
      packageCode: '1282581',
    });
  });

  it('covers every oil type the schema allows', () => {
    // A new OilType without codes would otherwise surface as an unpayable
    // listing at checkout rather than here.
    for (const type of Object.values(OilType)) {
      expect(resolveOilFiscalCodes(type)).not.toBeNull();
    }
  });

  it('returns null for a listing with no oil type — never a stand-in', () => {
    expect(resolveOilFiscalCodes(null)).toBeNull();
    expect(resolveOilFiscalCodes(undefined)).toBeNull();
  });

  it('keeps all three codes distinct and well-formed', () => {
    const codes = Object.values(OIL_TYPE_FISCAL);
    for (const { mxik, packageCode } of codes) {
      expect(MXIK_PATTERN.test(mxik)).toBe(true);
      expect(PACKAGE_CODE_PATTERN.test(packageCode)).toBe(true);
    }
    expect(new Set(codes.map((c) => c.mxik)).size).toBe(codes.length);
    expect(new Set(codes.map((c) => c.packageCode)).size).toBe(codes.length);
  });
});

/** The category of a listing, for the resolver. Unconfigured unless told otherwise. */
const bareCategory = (id: string, parentId: string | null = 'any-parent') => ({
  id,
  parentId,
  mxik: null,
  packageCodeSingle: null,
  packageCodeSet: null,
  packageCodeBox: null,
  fiscalConfirmedCodes: null,
  _count: { children: 0 },
});

const composition = (id: string) =>
  confirmedCategory({
    id,
    parentId: 'motor-oil',
    mxik: null,
    packageCodeSingle: null,
    packageCodeSet: null,
  });

const SYNTHETIC_CATEGORY = 'synthetic-motor-oil';

describe('resolveFiscalClassification — the MXIK has to be the right one', () => {
  const sparePart = (category: unknown, over = {}) => ({
    kind: ProductKind.SPARE_PART,
    oilType: null,
    packageForm: null,
    category: category as never,
    ...over,
  });

  it('gives a confirmed leaf its own codes, by the sale form', () => {
    expect(
      resolveFiscalClassification(
        sparePart(confirmedCategory(), { packageForm: PackageForm.SINGLE }),
      ),
    ).toEqual({
      ok: true,
      mxik: '08708005011000000',
      packageCode: '1417722',
    });
    expect(
      resolveFiscalClassification(
        sparePart(confirmedCategory(), { packageForm: PackageForm.SET }),
      ),
    ).toEqual({
      ok: true,
      mxik: '08708005011000000',
      packageCode: '1417723',
    });
  });

  describe('how the listing is sold', () => {
    const steering = confirmedCategory({ id: 'steering', ...STEERING });

    it.each([
      [PackageForm.SINGLE, '1417728'],
      [PackageForm.SET, '1417729'],
      [PackageForm.BOX, '1533557'],
    ])('%s reaches the receipt under its own code', (packageForm, code) => {
      expect(
        resolveFiscalClassification(sparePart(steering, { packageForm })),
      ).toEqual({ ok: true, mxik: STEERING.mxik, packageCode: code });
    });

    it('refuses a listing that states nothing where several forms are possible', () => {
      expect(resolveFiscalClassification(sparePart(steering))).toEqual({
        ok: false,
        gaps: [PACKAGE_FORM_NOT_STATED],
      });
      expect(
        resolveFiscalClassification(sparePart(confirmedCategory())),
      ).toEqual({ ok: false, gaps: [PACKAGE_FORM_NOT_STATED] });
    });

    it('takes the one code of a confirmed single-form category for an unstated listing', () => {
      expect(
        resolveFiscalClassification(
          sparePart(confirmedCategory({ packageCodeSet: null })),
        ),
      ).toEqual({
        ok: true,
        mxik: '08708005011000000',
        packageCode: '1417722',
      });
    });

    it.each([PackageForm.SET, PackageForm.BOX])(
      'refuses a %s listing on a category with no code for it, not a piece instead',
      (packageForm) => {
        const result = resolveFiscalClassification(
          sparePart(confirmedCategory({ packageCodeSet: null }), {
            packageForm,
          }),
        );
        expect(result.ok).toBe(false);
        expect((result as { gaps: string[] }).gaps[0]).toContain(
          `no package code for a listing sold as ${packageForm}`,
        );
      },
    );

    it('checks the code of the form sold, not only the single one', () => {
      const result = resolveFiscalClassification(
        sparePart(
          confirmedCategory({ packageCodeBox: 'one-box' }),
          { packageForm: PackageForm.BOX },
        ),
      );
      expect(result).toEqual({
        ok: false,
        gaps: ['category package code "one-box" is malformed'],
      });
    });

    it('editing the box code voids the confirmation with no further write', () => {
      expect(
        resolveFiscalClassification(
          sparePart(
            { ...steering, packageCodeBox: '1533558' },
            { packageForm: PackageForm.SINGLE },
          ),
        ),
      ).toEqual({ ok: false, gaps: [FISCAL_CODES_UNCONFIRMED] });
    });

    it.each([PackageForm.SET, PackageForm.BOX])(
      'the oil table holds no code for oil sold as %s',
      (packageForm) => {
        const composition = {
          ...bareCategory(SYNTHETIC_CATEGORY),
          fiscalConfirmedCodes: confirmableFiscalCodes(
            bareCategory(SYNTHETIC_CATEGORY),
          ),
        };
        const result = resolveFiscalClassification({
          kind: ProductKind.MOTOR_OIL,
          oilType: OilType.SYNTHETIC,
          packageForm,
          category: composition as never,
        });
        expect(result.ok).toBe(false);
        expect((result as { gaps: string[] }).gaps[0]).toContain(
          `no package code for a listing sold as ${packageForm}`,
        );
      },
    );

    it('the readiness of a category does not depend on any one listing', () => {
      expect(categoryFiscalReadiness(steering).status).toBe('READY');
    });
  });

  it('a code nobody confirmed does not reach a receipt, however plausible', () => {
    // The seed’s representative-product codes are exactly this state.
    expect(
      resolveFiscalClassification(
        sparePart(
          { ...confirmedCategory(), fiscalConfirmedCodes: null },
          { packageForm: PackageForm.SINGLE },
        ),
      ),
    ).toEqual({ ok: false, gaps: [FISCAL_CODES_UNCONFIRMED] });
  });

  it.each([
    ['the MXIK', { mxik: '08708005011999999' }],
    ['the single package code', { packageCodeSingle: '1417799' }],
    ['the set package code', { packageCodeSet: '1417799' }],
  ])('editing %s voids the confirmation with no further write', (_, change) => {
    expect(
      resolveFiscalClassification(
        sparePart(
          { ...confirmedCategory(), ...change },
          { packageForm: PackageForm.SINGLE },
        ),
      ),
    ).toEqual({ ok: false, gaps: [FISCAL_CODES_UNCONFIRMED] });
  });

  it('two nulls are no confirmation: a set code alone never reaches a receipt', () => {
    // A legacy or directly written row: the admin API refuses this shape. There is
    // nothing confirmable and nothing confirmed, and that must not read as a match.
    const setOnly = {
      ...bareCategory('brakes'),
      mxik: '08708005011000000',
      packageCodeSet: '1417723',
    };

    expect(
      resolveFiscalClassification(
        sparePart(setOnly, { packageForm: PackageForm.SET }),
      ),
    ).toEqual({ ok: false, gaps: ['category has no package code'] });
    expect(categoryFiscalReadiness(setOnly).status).toBe('NEEDS_CODES');
  });

  it('never inherits: a leaf with no code of its own is refused, whatever its parent has', () => {
    // There is simply no way to pass the parent in. This pins the outcome.
    expect(
      resolveFiscalClassification(
        sparePart(bareCategory('front-brake-pads', 'brake-system')),
      ),
    ).toEqual({
      ok: false,
      gaps: ['category has no MXIK', 'category has no package code'],
    });
  });

  it('refuses a parent as a filing: too broad to classify what sits on it', () => {
    const result = resolveFiscalClassification(
      sparePart(
        confirmedCategory({ id: 'transmission', _count: { children: 5 } }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gaps[0]).toMatch(/has subcategories/);
  });

  it('refuses the fallback bucket: an unclassified part has no code to speak of', () => {
    // Where every new Driver’s Village position starts.
    expect(
      resolveFiscalClassification(
        sparePart(
          confirmedCategory({ id: 'cat_uncategorized', parentId: null }),
        ),
      ),
    ).toEqual({ ok: false, gaps: ['listing is not classified yet'] });
  });

  it('refuses a malformed code rather than sending it', () => {
    const result = resolveFiscalClassification(
      sparePart(confirmedCategory({ mxik: '123' })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gaps[0]).toMatch(/malformed/);
  });

  it('refuses when the category itself is unknown', () => {
    expect(resolveFiscalClassification(sparePart(null))).toEqual({
      ok: false,
      gaps: ['category fiscal data is unavailable'],
    });
  });
});

describe('resolveFiscalClassification — oils', () => {
  const oil = (oilType: OilType | null, category: unknown) => ({
    kind: ProductKind.MOTOR_OIL,
    oilType,
    packageForm: null,
    category: category as never,
  });

  it.each([
    [OilType.SYNTHETIC, 'synthetic-motor-oil'],
    [OilType.SEMI_SYNTHETIC, 'semi-synthetic-motor-oil'],
    [OilType.MINERAL, 'mineral-motor-oil'],
  ])('a %s motor oil on %s takes that composition’s codes', (type, id) => {
    expect(resolveFiscalClassification(oil(type, composition(id)))).toEqual({
      ok: true,
      mxik: OIL_TYPE_FISCAL[type].mxik,
      packageCode: OIL_TYPE_FISCAL[type].packageCode,
    });
  });

  it('the oil table needs confirming too: being in the code is no proof', () => {
    expect(
      resolveFiscalClassification(
        oil(OilType.SYNTHETIC, bareCategory(SYNTHETIC_CATEGORY, 'motor-oil')),
      ),
    ).toEqual({ ok: false, gaps: [FISCAL_CODES_UNCONFIRMED] });
  });

  it('refuses a motor oil with no type, never picking one', () => {
    expect(
      resolveFiscalClassification(oil(null, composition(SYNTHETIC_CATEGORY))),
    ).toEqual({ ok: false, gaps: [OIL_TYPE_REQUIRED] });
  });

  it('refuses an oil type that contradicts its composition category', () => {
    const result = resolveFiscalClassification(
      oil(OilType.MINERAL, composition(SYNTHETIC_CATEGORY)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gaps[0]).toMatch(/contradicts/);
  });

  it('having an oil type does not make an industrial oil a motor oil', () => {
    // Under "Другое", with no code of its own: refused, not given a motor-oil MXIK.
    expect(
      resolveFiscalClassification(
        oil(OilType.SYNTHETIC, bareCategory('industrial-oil', 'other')),
      ),
    ).toEqual({
      ok: false,
      gaps: ['category has no MXIK', 'category has no package code'],
    });
    // With its own confirmed code, that code is the one used.
    expect(
      resolveFiscalClassification(
        oil(
          OilType.SYNTHETIC,
          confirmedCategory({
            id: 'industrial-oil',
            parentId: 'other',
            mxik: '02710005009000000',
            packageCodeSingle: '1282599',
            packageCodeSet: null,
          }),
        ),
      ),
    ).toEqual({
      ok: true,
      mxik: '02710005009000000',
      packageCode: '1282599',
    });
  });

  it('transmission oil takes its OWN confirmed codes, with no oil type', () => {
    const transmission = {
      id: 'transmission-oil',
      parentId: 'motor-oil',
      mxik: '02710005005000000',
      packageCodeSingle: '1282593',
      packageCodeSet: null,
    };
    expect(
      resolveFiscalClassification(oil(null, confirmedCategory(transmission))),
    ).toEqual({
      ok: true,
      mxik: '02710005005000000',
      packageCode: '1282593',
    });
    // …and stays blocked until somebody confirms them.
    expect(
      resolveFiscalClassification(
        oil(null, {
          ...transmission,
          fiscalConfirmedCodes: null,
          _count: { children: 0 },
        }),
      ),
    ).toEqual({ ok: false, gaps: [FISCAL_CODES_UNCONFIRMED] });
  });

  it('a motor oil on the `motor-oil` parent names no composition', () => {
    const result = resolveFiscalClassification(
      oil(
        OilType.SYNTHETIC,
        confirmedCategory({
          id: 'motor-oil',
          parentId: null,
          mxik: null,
          packageCodeSingle: null,
          packageCodeSet: null,
          _count: { children: 4 },
        }),
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('a spare part never takes an oil code, oil type or not', () => {
    // A brake category keeps its own code whatever stray oil type the row carries…
    expect(
      resolveFiscalClassification({
        kind: ProductKind.SPARE_PART,
        oilType: OilType.MINERAL,
        packageForm: null,
        category: confirmedCategory({ packageCodeSet: null }),
      }),
    ).toMatchObject({ ok: true, mxik: '08708005011000000' });
    // …and on a composition, which only holds motor oil, it is refused outright.
    // This is a Driver’s Village oil that has not been typed yet.
    const onComposition = resolveFiscalClassification({
      kind: ProductKind.SPARE_PART,
      oilType: null,
      packageForm: null,
      category: composition(SYNTHETIC_CATEGORY),
    });
    expect(onComposition.ok).toBe(false);
    if (!onComposition.ok) {
      expect(onComposition.gaps[0]).toMatch(/does not belong on category/);
    }
  });

  it('a motor oil on a brake category is refused: that MXIK does not describe it', () => {
    expect(
      resolveFiscalClassification(oil(OilType.MINERAL, confirmedCategory())),
    ).toMatchObject({ ok: false });
  });

  it('antifreeze belongs on its own node only', () => {
    expect(
      kindFitsCategory(ProductKind.ANTIFREEZE, {
        id: 'antifreeze',
        parentId: 'maintenance-and-fluids',
      }),
    ).toBe(true);
    expect(
      resolveFiscalClassification({
        kind: ProductKind.ANTIFREEZE,
        oilType: null,
        packageForm: null,
        category: confirmedCategory(),
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('a composition category with a code of its own', () => {
  const SYNTHETIC = 'synthetic-motor-oil';
  const OWN = '02710005999000000';
  const withOwnCode = confirmedCategory({
    id: SYNTHETIC,
    parentId: 'motor-oil',
    mxik: OWN,
    packageCodeSingle: '1282999',
    packageCodeSet: null,
  });
  const listing = (kind: ProductKind, oilType: OilType | null) => ({
    kind,
    oilType,
    packageForm: null,
    category: withOwnCode,
  });
  const OWN_CODES = { ok: true, mxik: OWN, packageCode: '1282999' };

  it('uses that code rather than the table’s', () => {
    expect(
      resolveFiscalClassification(
        listing(ProductKind.MOTOR_OIL, OilType.SYNTHETIC),
      ),
    ).toEqual(OWN_CODES);
  });

  it('that is the code an operator confirms', () => {
    expect(confirmableFiscalCodes(withOwnCode)).toBe(`${OWN}:1282999:`);
    expect(isFiscalizedByOilType(withOwnCode)).toBe(false);
    expect(categoryFiscalReadiness(withOwnCode).status).toBe('READY');
  });

  it('a confirmation of the table’s codes does not carry over to it', () => {
    const { mxik, packageCode } = OIL_TYPE_FISCAL[OilType.SYNTHETIC];
    expect(
      resolveFiscalClassification({
        ...listing(ProductKind.MOTOR_OIL, OilType.SYNTHETIC),
        category: {
          ...withOwnCode,
          fiscalConfirmedCodes: `${mxik}:${packageCode}:`,
        },
      }),
    ).toEqual({ ok: false, gaps: [FISCAL_CODES_UNCONFIRMED] });
  });

  it('a motor oil stating no type takes the type from the category', () => {
    expect(
      resolveFiscalClassification(listing(ProductKind.MOTOR_OIL, null)),
    ).toEqual(OWN_CODES);
  });

  it('a stated type contradicting the category is still refused', () => {
    expect(
      resolveFiscalClassification(
        listing(ProductKind.MOTOR_OIL, OilType.MINERAL),
      ),
    ).toEqual({
      ok: false,
      gaps: [`oil type MINERAL contradicts category "${SYNTHETIC}"`],
    });
    expect(
      resolveFiscalClassification(
        listing(ProductKind.SPARE_PART, OilType.MINERAL),
      ),
    ).toMatchObject({ ok: false });
  });

  it('a position an import left as a spare part is not blocked by that', () => {
    // What a 1C position is until someone types it. Filed here by hand, it takes the
    // code the operator confirmed for everything on this node.
    expect(
      resolveFiscalClassification(listing(ProductKind.SPARE_PART, null)),
    ).toEqual(OWN_CODES);
  });

  it('with no code of its own, the oil table stays motor oil’s alone', () => {
    expect(
      resolveFiscalClassification({
        kind: ProductKind.SPARE_PART,
        oilType: null,
        packageForm: null,
        category: composition(SYNTHETIC),
      }),
    ).toMatchObject({ ok: false });
  });

  it('antifreeze does not belong there, code or not', () => {
    expect(
      resolveFiscalClassification(listing(ProductKind.ANTIFREEZE, null)),
    ).toMatchObject({ ok: false });
  });

  it('a move still has to state the kind: no silent retyping', () => {
    expect(kindFitsCategory(ProductKind.SPARE_PART, withOwnCode)).toBe(false);
  });
});

describe('kindFitsCategory — an oil node’s own subcategories', () => {
  it.each([
    ['motor-oil', 'an operator’s subcategory of motor oil'],
    ['synthetic-motor-oil', 'a subcategory of a composition'],
    ['transmission-oil', 'a subcategory of transmission oil'],
    ['oil-and-fluids', 'a subcategory of the fluids bucket'],
    ['other', 'a child of "Другое"'],
  ])('a motor oil fits under %s: %s', (parentId) => {
    expect(
      kindFitsCategory(ProductKind.MOTOR_OIL, { id: 'custom', parentId }),
    ).toBe(true);
  });

  it('antifreeze fits under its own node, and a motor oil does not', () => {
    expect(
      kindFitsCategory(ProductKind.ANTIFREEZE, {
        id: 'custom',
        parentId: 'antifreeze',
      }),
    ).toBe(true);
    expect(
      kindFitsCategory(ProductKind.MOTOR_OIL, {
        id: 'custom',
        parentId: 'antifreeze',
      }),
    ).toBe(false);
  });

  it('a motor oil still does not fit under a brake category', () => {
    expect(
      kindFitsCategory(ProductKind.MOTOR_OIL, {
        id: 'brake-discs',
        parentId: 'brake-system',
      }),
    ).toBe(false);
  });
});

describe('the four nodes seeded with a code for one product of many', () => {
  describe.each(Object.entries(REPRESENTATIVE_ONLY_MXIK))('%s', (id, mxik) => {
    const seeded = {
      ...bareCategory(id, 'a-root'),
      mxik,
      packageCodeSingle: '1350563',
    };
    const onIt = (category: unknown) => ({
      kind: ProductKind.SPARE_PART,
      oilType: null,
      packageForm: null,
      category: category as never,
    });

    it('holding it, with no children: not sellable, and nothing to confirm', () => {
      expect(categoryFiscalReadiness(seeded).status).toBe('NOT_SELLABLE');
      expect(confirmableFiscalCodes(seeded)).toBeNull();
    });

    it('a listing on it is refused, even against a stored confirmation', () => {
      const result = resolveFiscalClassification(
        onIt({ ...seeded, fiscalConfirmedCodes: `${mxik}:1350563:` }),
      );
      expect(result.ok).toBe(false);
    });

    it('with active children it is a parent, whatever code it holds', () => {
      const parent = confirmedCategory({
        id,
        parentId: 'a-root',
        mxik: '09999999999999902',
        packageCodeSet: null,
        _count: { children: 3 },
      });
      expect(categoryFiscalReadiness(parent).status).toBe('NOT_SELLABLE');
      expect(resolveFiscalClassification(onIt(parent)).ok).toBe(false);
    });

    it('a different code entered by an operator is an ordinary leaf', () => {
      const different = {
        ...seeded,
        mxik: '09999999999999902',
      };
      expect(categoryFiscalReadiness(different).status).toBe(
        'NEEDS_CONFIRMATION',
      );
      expect(
        resolveFiscalClassification(
          onIt({
            ...different,
            fiscalConfirmedCodes: '09999999999999902:1350563:',
          }),
        ),
      ).toEqual({
        ok: true,
        mxik: '09999999999999902',
        packageCode: '1350563',
      });
    });

    it('a confirmed subcategory under it carries its own MXIK and becomes READY', () => {
      const sub = confirmedCategory({
        id: `${id}-sub`,
        parentId: id,
        mxik: '09999999999999903',
        packageCodeSingle: '1000009',
        packageCodeSet: null,
      });
      expect(categoryFiscalReadiness(sub).status).toBe('READY');
      expect(resolveFiscalClassification(onIt(sub))).toEqual({
        ok: true,
        mxik: '09999999999999903',
        packageCode: '1000009',
      });
    });
  });
});

describe('the one place a receipt’s MXIK comes from', () => {
  // A scan, because the rule is about what does NOT exist: a second reader that could
  // give the same product a different code. Anything reading `.mxik` has to be one of
  // these, or be on this list for a reason someone wrote down.
  it('no other file reads a category’s MXIK', () => {
    const root = join(__dirname, '..');
    const allowed = new Set([
      'common/fiscal.util.ts', // the resolver
      'catalog/categories/category-map.ts', // isFiscalizedByOilType
      'orders/webhooks/payme-fiscal.util.ts', // the resolved code, and a fee's config
      'orders/webhooks/payme-fiscal.service.ts', // delivery's system code, not a category's
      'orders/webhooks/payme.config.ts', // keeps the service fee off delivery's system code
      'admin/categories/admin-categories.presenter.ts', // shows it to an operator
      'admin/categories/admin-categories.service.ts', // an operator editing it
      'admin/categories/admin-category-transfer.service.ts', // warns that it differs
      'prisma/seed-data/catalog-reference.seed.ts', // the candidates themselves
    ]);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : [join(dir, entry.name)],
      );
    const readers = walk(root)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => !/\.spec\.ts$|test-util\.ts$/.test(file))
      .filter((file) => /\.mxik\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));

    expect(readers.filter((file) => !allowed.has(file))).toEqual([]);
  });
});

describe('categoryFiscalReadiness — what an operator still has to do', () => {
  it.each([
    ['codes confirmed', confirmedCategory(), 'READY'],
    ['composition confirmed', composition(SYNTHETIC_CATEGORY), 'READY'],
    [
      'codes nobody confirmed',
      { ...confirmedCategory(), fiscalConfirmedCodes: null },
      'NEEDS_CONFIRMATION',
    ],
    [
      'composition nobody confirmed',
      bareCategory(SYNTHETIC_CATEGORY, 'motor-oil'),
      'NEEDS_CONFIRMATION',
    ],
    ['no codes', bareCategory('front-brake-pads'), 'NEEDS_CODES'],
    [
      'a parent',
      confirmedCategory({ id: 'transmission', _count: { children: 5 } }),
      'NOT_SELLABLE',
    ],
    ['the fallback bucket', bareCategory('cat_uncategorized'), 'NOT_SELLABLE'],
  ])('%s → %s', (_, category, status) => {
    expect(categoryFiscalReadiness(category as never).status).toBe(status);
  });
});

describe('confirmableFiscalCodes', () => {
  it('states all the codes, so editing any one voids a confirmation', () => {
    expect(confirmableFiscalCodes({ id: 'brakes', ...BOTH })).toBe(
      '08708005011000000:1417722:1417723',
    );
    expect(confirmableFiscalCodes({ id: 'filters', ...SINGLE_ONLY })).toBe(
      '08421002001000000:1499205:',
    );
  });

  it('reads a composition’s codes from the oil table, not its empty columns', () => {
    const { mxik, packageCode } = OIL_TYPE_FISCAL[OilType.SYNTHETIC];
    expect(
      confirmableFiscalCodes({ id: SYNTHETIC_CATEGORY, ...UNCONFIGURED }),
    ).toBe(`${mxik}:${packageCode}:`);
  });

  it('is null when there is nothing to confirm', () => {
    expect(
      confirmableFiscalCodes({ id: 'brakes', ...UNCONFIGURED }),
    ).toBeNull();
  });
});

describe('dealer tax data', () => {
  it('reports what is missing, and takes 0 for the rate it is', () => {
    expect(dealerFiscalGaps(null)).toEqual(['dealer is unavailable']);
    expect(dealerFiscalGaps({ tin: null, vatPercent: null })).toEqual([
      'dealer has no TIN',
      'dealer has no VAT percentage',
    ]);
    expect(dealerFiscalGaps({ tin: '301234567', vatPercent: 0 })).toEqual([]);
  });

  it('refuses tax data that could not go on a receipt as it stands', () => {
    // The admin API validates both: this is for what reached the table another way.
    expect(dealerFiscalGaps({ tin: '30123456X', vatPercent: 12 })).toEqual([
      'dealer TIN is malformed',
    ]);
    expect(dealerFiscalGaps({ tin: '301234567', vatPercent: 101 })).toEqual([
      'dealer VAT percentage is out of range',
    ]);
    expect(dealerFiscalGaps({ tin: '301234567', vatPercent: -1 })).toEqual([
      'dealer VAT percentage is out of range',
    ]);
    expect(
      dealerFiscalGaps({ tin: '301234567', vatPercent: undefined }),
    ).toEqual(['dealer has no VAT percentage']);
  });

  it.each([0, 4, 6, 12, 12.5, 100])(
    'takes any rate the operator stated within 0–100: %s',
    (rate) => {
      for (const vatPercent of [rate, new Prisma.Decimal(rate)]) {
        expect(dealerFiscalGaps({ tin: '301234567', vatPercent })).toEqual([]);
      }
    },
  );

  it('reads the rate as the Decimal the column holds', () => {
    // Decimal(5,2) hands back 12.00, 4.00, 0.00: still the rates they are.
    for (const rate of ['12.00', '4.00', '6.00', '0.00', '12.5']) {
      expect(
        dealerFiscalGaps({
          tin: '12345678901234',
          vatPercent: new Prisma.Decimal(rate),
        }),
      ).toEqual([]);
    }
  });

  it('joins the classification in the one listing verdict', () => {
    expect(
      listingFiscalGaps({
        kind: ProductKind.SPARE_PART,
        oilType: null,
        packageForm: null,
        category: bareCategory('front-brake-pads'),
        dealer: { tin: null, vatPercent: 0 },
      }),
    ).toEqual([
      'category has no MXIK',
      'category has no package code',
      'dealer has no TIN',
    ]);
  });
});

describe('decideListingMove — the rule every operator move shares', () => {
  const target = (id: string, parentId: string | null = 'motor-oil') => ({
    id,
    parentId,
  });
  const motorOil = (oilType: OilType | null, categoryId: string) => ({
    kind: ProductKind.MOTOR_OIL,
    oilType,
    categoryId,
  });

  it('re-filing between compositions takes the target’s type: the old one was derived', () => {
    expect(
      decideListingMove(
        motorOil(OilType.SYNTHETIC, SYNTHETIC_CATEGORY),
        target('mineral-motor-oil'),
      ),
    ).toEqual({ ok: true, oilType: OilType.MINERAL });
  });

  it('a type the seller stated elsewhere must not be overwritten by a bulk move', () => {
    expect(
      decideListingMove(
        motorOil(OilType.MINERAL, 'oil-and-fluids'),
        target(SYNTHETIC_CATEGORY),
      ),
    ).toMatchObject({ ok: false, code: 'OIL_TYPE_CONFLICT' });
  });

  it('an oil with no type takes the composition the operator chose', () => {
    expect(
      decideListingMove(
        motorOil(null, 'oil-and-fluids'),
        target(SYNTHETIC_CATEGORY),
      ),
    ).toEqual({ ok: true, oilType: OilType.SYNTHETIC });
  });

  it('transmission oil denotes no composition, so the old type goes', () => {
    expect(
      decideListingMove(
        motorOil(OilType.SYNTHETIC, SYNTHETIC_CATEGORY),
        target('transmission-oil'),
      ),
    ).toEqual({ ok: true, oilType: null });
  });

  it('the `motor-oil` parent cannot say which composition: refused', () => {
    expect(
      decideListingMove(
        motorOil(OilType.SYNTHETIC, SYNTHETIC_CATEGORY),
        target('motor-oil', null),
      ),
    ).toMatchObject({ ok: false, code: 'OIL_COMPOSITION_REQUIRED' });
  });

  it('a "Другое" child keeps the stated type: it decides none', () => {
    expect(
      decideListingMove(
        motorOil(OilType.MINERAL, 'oil-and-fluids'),
        target('industrial-oil', 'other'),
      ),
    ).toEqual({ ok: true, oilType: OilType.MINERAL });
  });

  it('a move never changes a kind: a spare part cannot become a composition’s oil', () => {
    expect(
      decideListingMove(
        { kind: ProductKind.SPARE_PART, oilType: null, categoryId: 'brakes' },
        target(SYNTHETIC_CATEGORY),
      ),
    ).toMatchObject({ ok: false, code: 'KIND_MISMATCH' });
  });

  it('nor can a motor oil land on a brake category', () => {
    expect(
      decideListingMove(
        motorOil(OilType.MINERAL, 'mineral-motor-oil'),
        target('brakes', 'brake-system'),
      ),
    ).toMatchObject({ ok: false, code: 'KIND_MISMATCH' });
  });

  it('an ordinary part moves freely and keeps what it has', () => {
    expect(
      decideListingMove(
        { kind: ProductKind.SPARE_PART, oilType: null, categoryId: 'brakes' },
        target('air-filters', 'maintenance-and-fluids'),
      ),
    ).toEqual({ ok: true, oilType: null });
  });
});

describe('isFiscalizedByOilType', () => {
  it('covers exactly the three composition categories', () => {
    for (const id of [
      'synthetic-motor-oil',
      'semi-synthetic-motor-oil',
      'mineral-motor-oil',
    ]) {
      expect(isFiscalizedByOilType({ id, parentId: 'motor-oil' })).toBe(true);
    }
    // None of these names a composition.
    expect(isFiscalizedByOilType({ id: 'motor-oil', parentId: null })).toBe(
      false,
    );
    expect(
      isFiscalizedByOilType({ id: 'transmission-oil', parentId: 'motor-oil' }),
    ).toBe(false);
    expect(
      isFiscalizedByOilType({ id: 'motorcycle-oil', parentId: 'other' }),
    ).toBe(false);
    expect(
      isFiscalizedByOilType({ id: 'industrial-oil', parentId: 'other' }),
    ).toBe(false);
  });

  it('leaves every ordinary category on the category path', () => {
    expect(
      isFiscalizedByOilType({ id: 'brakes', parentId: 'brake-system' }),
    ).toBe(false);
    // 'oil-and-fluids' is a SPARE_PART leaf under maintenance-and-fluids: its
    // listings never run the oil questionnaire, so they need real codes.
    expect(
      isFiscalizedByOilType({
        id: 'oil-and-fluids',
        parentId: 'maintenance-and-fluids',
      }),
    ).toBe(false);
  });

  it('leaves ANTIFREEZE on the category path — it has its own IKPU', () => {
    // The `antifreeze` node is an ordinary leaf under maintenance-and-fluids, so
    // its listings are fiscalized from ITS columns. Reporting it as
    // oil-fiscalized would tell the admin console it needs no codes, and its
    // products would then resolve to a motor-oil MXIK.
    expect(
      isFiscalizedByOilType({
        id: 'antifreeze',
        parentId: 'maintenance-and-fluids',
      }),
    ).toBe(false);
  });
});

describe('the three oil codes are exactly the ones the registry issued', () => {
  // Pinned literally, not derived: the whole point of the table is that the
  // synthetic code can never end up on a mineral oil, so a typo here must fail
  // loudly rather than be re-derived from the same source it is checking.
  it.each([
    [OilType.SYNTHETIC, '02710005001000000', '1282037'],
    [OilType.SEMI_SYNTHETIC, '02710005002000000', '1282031'],
    [OilType.MINERAL, '02710005003000000', '1282581'],
  ])('%s → %s / %s', (type, mxik, packageCode) => {
    expect(resolveOilFiscalCodes(type)).toEqual({ mxik, packageCode });
  });
});

describe('formats', () => {
  it('accepts a 17-digit MXIK and rejects anything else', () => {
    expect(MXIK_PATTERN.test('08708005011000000')).toBe(true);
    expect(MXIK_PATTERN.test('0870800501100000')).toBe(false); // 16
    expect(MXIK_PATTERN.test('087080050110000000')).toBe(false); // 18
    expect(MXIK_PATTERN.test('0870800501100000X')).toBe(false);
  });

  it('accepts a digits-only package code', () => {
    expect(PACKAGE_CODE_PATTERN.test('1417722')).toBe(true);
    expect(PACKAGE_CODE_PATTERN.test('')).toBe(false);
    expect(PACKAGE_CODE_PATTERN.test('14177-22')).toBe(false);
  });

  it('accepts a 9-digit ИНН and a 14-digit ПИНФЛ, and nothing between', () => {
    expect(TIN_PATTERN.test('301234567')).toBe(true);
    expect(TIN_PATTERN.test('12345678901234')).toBe(true);
    expect(TIN_PATTERN.test('30123456')).toBe(false); // 8
    expect(TIN_PATTERN.test('3012345678')).toBe(false); // 10
    expect(TIN_PATTERN.test('30123456A')).toBe(false);
    // Leading zeros are significant — the value is a string, never a number.
    expect(TIN_PATTERN.test('001234567')).toBe(true);
  });
});
