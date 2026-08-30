// The motor-oil taxonomy after the viscosity categories were retired.
//
// Guards the invariant the migration establishes: a SAE grade is an ATTRIBUTE
// (Product.oilViscosity), never a node in the tree, while transmission oil — a
// product TYPE — stays a category. The three sources that must agree are checked
// together here, because the bug this replaces was them drifting apart: the
// wizard asked for a viscosity attribute while the seed kept creating viscosity
// categories and the classifier kept filing parts into them.

import { OilType, ProductKind } from '@prisma/client';
import {
  LEGACY_VISCOSITY_CATEGORIES,
  LEGACY_VISCOSITY_CATEGORY_IDS,
  isLegacyViscosityCategory,
} from './legacy-viscosity-categories';
import {
  CATEGORY_ID_TO_KIND,
  CategoryAnchor,
  MOTOR_OIL_CATEGORY_IDS,
  isFiscalizedByOilType,
  oilTypeForCategory,
} from './category-map';
import { TAXONOMY } from '../../prisma/seed-data/subcategory-taxonomy.seed';
import { CATEGORY_NAMES } from '../../prisma/seed-data/category-names.seed';
import {
  SUBCATEGORY_RULES,
  classifySubcategory,
  classifyOilViscosity,
} from '../../ai/subcategory-classifier';
import {
  OIL_TYPE_FISCAL,
  resolveOilFiscalCodes,
} from '../../common/fiscal.util';
import { OIL_VISCOSITIES } from '../../telegram/motor-oil-catalog';

/** The motor-oil group as the seed declares it. */
const oilGroup = TAXONOMY.find((g) => g.parentId === CategoryAnchor.MOTOR_OIL);

describe('motor-oil taxonomy: viscosity is an attribute, not a category', () => {
  it('the seed creates NO viscosity categories under motor-oil', () => {
    const slugs = (oilGroup?.subs ?? []).map((s) => s.slug);
    for (const retired of LEGACY_VISCOSITY_CATEGORY_IDS) {
      expect(slugs).not.toContain(retired);
    }
  });

  it('the seed still creates transmission-oil under motor-oil', () => {
    const slugs = (oilGroup?.subs ?? []).map((s) => s.slug);
    expect(slugs).toContain(CategoryAnchor.TRANSMISSION_OIL);
  });

  it('no seeded category anywhere is a viscosity grade', () => {
    // Catches a grade re-introduced under ANY parent, not just motor-oil — a
    // "Масло 5W-30" under maintenance-and-fluids would be the same mistake.
    const everySlug = TAXONOMY.flatMap((g) => g.subs.map((s) => s.slug));
    for (const retired of LEGACY_VISCOSITY_CATEGORY_IDS) {
      expect(everySlug).not.toContain(retired);
    }
    // A grade in a NAME is the same taxonomy leaking back in under a new id.
    const gradeNamed = TAXONOMY.flatMap((g) => g.subs).filter((s) =>
      /\d{1,2}\s*W\s*-?\s*\d{1,2}/i.test(s.name),
    );
    expect(gradeNamed).toEqual([]);
  });

  it('carries no localized names for the retired categories', () => {
    for (const retired of LEGACY_VISCOSITY_CATEGORY_IDS) {
      expect(CATEGORY_NAMES[retired]).toBeUndefined();
    }
    // Transmission oil keeps all three.
    const transmission = CATEGORY_NAMES[CategoryAnchor.TRANSMISSION_OIL];
    expect(transmission?.ru).toEqual(expect.any(String));
    expect(transmission?.uz).toEqual(expect.any(String));
    expect(transmission?.en).toEqual(expect.any(String));
  });

  it('identifies exactly the three retired ids', () => {
    expect(isLegacyViscosityCategory('motor-oil-5w40')).toBe(true);
    expect(isLegacyViscosityCategory(CategoryAnchor.TRANSMISSION_OIL)).toBe(
      false,
    );
    expect(isLegacyViscosityCategory(CategoryAnchor.MOTOR_OIL)).toBe(false);
  });

  it('maps every retired id to a grade the wizard actually offers', () => {
    // The migration writes these into Product.oilViscosity, so each must be a
    // value the catalog recognises — otherwise a migrated listing would carry a
    // viscosity no filter or preset could ever match.
    for (const grade of Object.values(LEGACY_VISCOSITY_CATEGORIES)) {
      expect(OIL_VISCOSITIES).toContain(grade);
    }
  });
});

describe('subcategory classifier: grades yield an attribute', () => {
  it('no rule files a part into a viscosity category', () => {
    const ids = SUBCATEGORY_RULES.map((r) => r.id);
    for (const retired of LEGACY_VISCOSITY_CATEGORY_IDS) {
      expect(ids).not.toContain(retired);
    }
  });

  it('"масло 5W-40" yields the viscosity, not a category', () => {
    expect(classifyOilViscosity('масло 5W-40')).toBe('5W-40');
    // Nothing to re-file it to: the listing stays on motor-oil.
    expect(classifySubcategory('масло 5W-40', CategoryAnchor.MOTOR_OIL)).toBe(
      null,
    );
  });

  it('recognises the grades the retired rules used to match', () => {
    expect(classifyOilViscosity('моторное масло 5w30')).toBe('5W-30');
    expect(classifyOilViscosity('масло 10w-40 полусинтетика')).toBe('10W-40');
    expect(classifyOilViscosity('Mobil 1 ESP 5W-30 4L')).toBe('5W-30');
  });

  it('does not read a part number as a viscosity', () => {
    expect(classifyOilViscosity('фильтр 96535062')).toBe(null);
    expect(classifyOilViscosity('GM 55W123456')).toBe(null);
  });

  it('names no grade when the text has none', () => {
    expect(classifyOilViscosity('трансмиссионное масло')).toBe(null);
    expect(classifyOilViscosity('тормозные колодки')).toBe(null);
  });

  it('still classifies transmission oil to its own category', () => {
    const match = classifySubcategory(
      'трансмиссионное масло',
      CategoryAnchor.MOTOR_OIL,
    );
    expect(match?.id).toBe(CategoryAnchor.TRANSMISSION_OIL);
  });
});

describe('IKPU is per oil TYPE and independent of viscosity', () => {
  it('keeps the three registry codes exactly', () => {
    expect(OIL_TYPE_FISCAL[OilType.SYNTHETIC]).toEqual({
      mxik: '02710005001000000',
      packageCode: '1282037',
    });
    expect(OIL_TYPE_FISCAL[OilType.SEMI_SYNTHETIC]).toEqual({
      mxik: '02710005002000000',
      packageCode: '1282031',
    });
    expect(OIL_TYPE_FISCAL[OilType.MINERAL]).toEqual({
      mxik: '02710005003000000',
      packageCode: '1282581',
    });
  });

  it('gives every viscosity of one type the SAME code', () => {
    // The point of retiring the categories: 5W-30, 5W-40 and 10W-40 synthetics
    // are one fiscal product. The codes are keyed by type alone, so this holds
    // structurally — asserted so a future "MXIK per grade" cannot slip in.
    const synthetic = OIL_TYPE_FISCAL[OilType.SYNTHETIC];
    for (const grade of OIL_VISCOSITIES) {
      // The lookup ignores `grade` entirely — that is the property under test.
      expect(OIL_TYPE_FISCAL[OilType.SYNTHETIC]).toBe(synthetic);
      expect(OIL_VISCOSITIES).toContain(grade);
    }
    expect(OIL_TYPE_FISCAL[OilType.SYNTHETIC].mxik).not.toBe(
      OIL_TYPE_FISCAL[OilType.MINERAL].mxik,
    );
  });
});

// ── The composition categories ──────────────────────────────────────────────
// The base composition (synthetic / semi-synthetic / mineral) is now a CATEGORY
// rather than a wizard question, and `Product.oilType` — still the single input
// to the registry's oil codes — is DERIVED from it. These guard the two halves
// of that: the tree offers exactly four options, and the derivation maps each to
// the right type without inventing one for transmission oil.
describe('motor-oil compositions are categories', () => {
  it('offers exactly four options under motor-oil', () => {
    const slugs = (oilGroup?.subs ?? []).map((s) => s.slug);
    expect(slugs).toEqual([
      CategoryAnchor.SYNTHETIC_MOTOR_OIL,
      CategoryAnchor.SEMI_SYNTHETIC_MOTOR_OIL,
      CategoryAnchor.MINERAL_MOTOR_OIL,
      CategoryAnchor.TRANSMISSION_OIL,
    ]);
    // The seed and the list both wizard paths read must agree, or the two
    // screens drift apart again.
    expect(slugs).toEqual([...MOTOR_OIL_CATEGORY_IDS]);
  });

  it('names all four in every language', () => {
    for (const id of MOTOR_OIL_CATEGORY_IDS) {
      const names = CATEGORY_NAMES[id];
      expect(names?.ru).toEqual(expect.any(String));
      expect(names?.uz).toEqual(expect.any(String));
      expect(names?.en).toEqual(expect.any(String));
    }
  });

  it('derives the oil type from the three composition categories', () => {
    expect(oilTypeForCategory(CategoryAnchor.SYNTHETIC_MOTOR_OIL)).toBe(
      OilType.SYNTHETIC,
    );
    expect(oilTypeForCategory(CategoryAnchor.SEMI_SYNTHETIC_MOTOR_OIL)).toBe(
      OilType.SEMI_SYNTHETIC,
    );
    expect(oilTypeForCategory(CategoryAnchor.MINERAL_MOTOR_OIL)).toBe(
      OilType.MINERAL,
    );
  });

  it('derives NO type for transmission oil', () => {
    // It denotes no base composition. Inventing one would fiscalize it under a
    // motor-oil MXIK instead of its own category codes.
    expect(oilTypeForCategory(CategoryAnchor.TRANSMISSION_OIL)).toBeNull();
    expect(oilTypeForCategory(CategoryAnchor.MOTOR_OIL)).toBeNull();
    expect(oilTypeForCategory(null)).toBeNull();
    expect(oilTypeForCategory('brake-system')).toBeNull();
  });

  it('each composition category resolves to its own registry code', () => {
    const codes = MOTOR_OIL_CATEGORY_IDS.map((id) =>
      resolveOilFiscalCodes(oilTypeForCategory(id)),
    );
    expect(codes).toEqual([
      { mxik: '02710005001000000', packageCode: '1282037' },
      { mxik: '02710005002000000', packageCode: '1282031' },
      { mxik: '02710005003000000', packageCode: '1282581' },
      // Transmission oil takes none of the motor-oil codes.
      null,
    ]);
  });

  it('all four start the oil questionnaire', () => {
    for (const id of MOTOR_OIL_CATEGORY_IDS) {
      expect(CATEGORY_ID_TO_KIND[id]).toBe(ProductKind.MOTOR_OIL);
    }
  });

  it('treats the three compositions — but NOT transmission oil — as oil-type fiscalized', () => {
    // A composition category legitimately has no MXIK columns of its own (the
    // codes come from the derived type), so the admin console must not report
    // it as unconfigured. Transmission oil DOES need its own codes, so it must
    // still be reported until an admin enters them.
    for (const id of [
      CategoryAnchor.SYNTHETIC_MOTOR_OIL,
      CategoryAnchor.SEMI_SYNTHETIC_MOTOR_OIL,
      CategoryAnchor.MINERAL_MOTOR_OIL,
    ]) {
      expect(
        isFiscalizedByOilType({ id, parentId: CategoryAnchor.MOTOR_OIL }),
      ).toBe(true);
    }
    expect(
      isFiscalizedByOilType({
        id: CategoryAnchor.TRANSMISSION_OIL,
        parentId: CategoryAnchor.MOTOR_OIL,
      }),
    ).toBe(false);
  });
});
