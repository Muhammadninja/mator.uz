// The shared fiscal rules: when a category counts as configured, when the
// seller must be asked how an item is sold, and which of a category's two
// Tasnif package codes fiscalizes a listing. Pure functions — no DB, no Nest.
//
// These are the rules the admin console, the Telegram wizard and the Payme
// receipt builder all read, so pinning them here pins all three at once.

import { OilType, PackageForm } from '@prisma/client';
import {
  isCategoryFiscallyConfigured,
  offersPackageChoice,
  resolveOilFiscalCodes,
  resolvePackageCode,
  MXIK_PATTERN,
  OIL_TYPE_FISCAL,
  PACKAGE_CODE_PATTERN,
  TIN_PATTERN,
} from './fiscal.util';
import { isFiscalizedByOilType } from '../catalog/categories/category-map';

/** Brakes, as supplied: sold both as a single item and as a set. */
const BOTH = {
  mxik: '08708005011000000',
  packageCodeSingle: '1417722',
  packageCodeSet: '1417723',
};

/** Filters, as supplied: one package code only. */
const SINGLE_ONLY = {
  mxik: '08421002001000000',
  packageCodeSingle: '1499205',
  packageCodeSet: null,
};

const UNCONFIGURED = {
  mxik: null,
  packageCodeSingle: null,
  packageCodeSet: null,
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
      }),
    ).toBe(false);
  });

  it('treats an untouched category as unconfigured', () => {
    expect(isCategoryFiscallyConfigured(UNCONFIGURED)).toBe(false);
  });
});

describe('offersPackageChoice', () => {
  it('is true only when BOTH codes are present', () => {
    expect(offersPackageChoice(BOTH)).toBe(true);
    expect(offersPackageChoice(SINGLE_ONLY)).toBe(false);
    expect(offersPackageChoice(UNCONFIGURED)).toBe(false);
  });
});

describe('resolvePackageCode', () => {
  it('uses the SET code when the seller chose "Комплект / набор"', () => {
    expect(resolvePackageCode(BOTH, PackageForm.SET)).toBe('1417723');
  });

  it('uses the SINGLE code when the seller chose "Штука"', () => {
    expect(resolvePackageCode(BOTH, PackageForm.SINGLE)).toBe('1417722');
  });

  it('uses the single code when the question was never asked (null form)', () => {
    expect(resolvePackageCode(SINGLE_ONLY, null)).toBe('1499205');
    expect(resolvePackageCode(BOTH, null)).toBe('1417722');
  });

  it('never picks the code by ORDER — the two forms are named, not positional', () => {
    // Same two codes, entered the other way round: the SET answer still yields
    // the code stored as the set code.
    const swapped = {
      packageCodeSingle: '1417723',
      packageCodeSet: '1417722',
    };
    expect(resolvePackageCode(swapped, PackageForm.SET)).toBe('1417722');
    expect(resolvePackageCode(swapped, PackageForm.SINGLE)).toBe('1417723');
  });

  it('falls back to the single code when a SET choice outlives its code', () => {
    // An admin removed the set code after the seller answered "Комплект".
    expect(resolvePackageCode(SINGLE_ONLY, PackageForm.SET)).toBe('1499205');
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

describe('isFiscalizedByOilType', () => {
  it('covers the oil anchor and every "Другое" child', () => {
    // These are exactly the categories whose listings come out as MOTOR_OIL.
    expect(isFiscalizedByOilType({ id: 'motor-oil', parentId: null })).toBe(
      true,
    );
    expect(
      isFiscalizedByOilType({ id: 'motorcycle-oil', parentId: 'other' }),
    ).toBe(true);
    expect(
      isFiscalizedByOilType({ id: 'industrial-oil', parentId: 'other' }),
    ).toBe(true);
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
