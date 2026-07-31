// MOTOR_OIL universality and vehicle compatibility, end to end.
//
// THE BUSINESS RULE under test:
//   • an oil sold FOR a specific make/model is NOT universal and keeps that
//     vehicle's compatibility;
//   • an oil listed under "Другое" IS universal and carries no vehicle at all.
// Both are the same ProductKind, which is exactly why universality cannot be
// derived from the kind — the bug these tests lock out.
//
// Covers the whole path: wizard session → draft fields → isUniversalFor →
// persistVehicleLinks → the buyer card's compatibility.

import { OilType, ProductKind } from '@prisma/client';
import { hasCompatibility, isUniversalFor } from '../common/product-kind';
import { persistVehicleLinks } from './vehicle-links';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  beginQuestionnaire,
  goBack,
  selectBrand,
  selectCategory,
  selectModel,
  selectOilType,
  selectOilViscosity,
  selectOilVolume,
  selectOtherBrand,
  selectOtherCategory,
} from './product-wizard';
import { OIL_TYPES, OIL_VISCOSITIES, OIL_VOLUMES } from './motor-oil-catalog';

const CHEVROLET = 0;
const COBALT = 0;
const FIVE_W_30 = OIL_VISCOSITIES.indexOf('5W-30');
const SYNTHETIC = OIL_TYPES.findIndex((t) => t.value === OilType.SYNTHETIC);
const FOUR_LITRES = OIL_VOLUMES.findIndex((v) => v.value === 4_000);

/** The CATEGORY step's options, as the bot loads them from the dynamic tree. */
const CATEGORY_ROOTS = [
  { id: 'brake-system', name: 'Тормозная система' },
  // Declares the oil questionnaire via its STABLE id, not its name.
  { id: 'motor-oil', name: 'Моторные масла', kind: ProductKind.MOTOR_OIL },
];

/** The admin-managed "Другое" catalogue. */
const OTHER_OPTIONS = [
  { id: 'motor-oil', name: 'Моторные масла', kind: ProductKind.MOTOR_OIL },
  { id: 'motorcycle-oil', name: 'Мотоциклетные масла' },
];

function freshSession(): WizardSession {
  const s = new WizardSessionStore().start(1);
  beginQuestionnaire(s);
  return s;
}

/** Oil FOR a specific car: brand → model → category "Моторные масла". */
function oilForCobalt(): WizardSession {
  const s = freshSession();
  selectBrand(s, CHEVROLET);
  selectModel(s, COBALT);
  s.categoryOptions = CATEGORY_ROOTS;
  selectCategory(s, 'motor-oil', []);
  return s;
}

/** Oil via "Другое": no vehicle at all. */
function oilViaOther(): WizardSession {
  const s = freshSession();
  selectOtherBrand(s);
  s.categoryOptions = OTHER_OPTIONS;
  selectOtherCategory(s, 'motor-oil');
  return s;
}

/** Answer the three oil questions from wherever the session stands. */
function answerOilQuestions(s: WizardSession): WizardSession {
  selectOilViscosity(s, FIVE_W_30);
  selectOilType(s, SYNTHETIC);
  selectOilVolume(s, FOUR_LITRES);
  return s;
}

describe('1. MOTOR_OIL + specific make/model → isUniversal = false', () => {
  it('keeps the chosen vehicle and switches to the oil questionnaire', () => {
    const s = oilForCobalt();
    expect(s.kind).toBe(ProductKind.MOTOR_OIL);
    // The vehicle is KEPT — this is what makes the listing specific.
    expect(s.brand).toBe('Chevrolet');
    expect(s.model).toBe('Cobalt');
    expect(s.step).toBe(WizardStep.OIL_VISCOSITY);
  });

  it('is NOT universal, despite being a MOTOR_OIL', () => {
    const s = oilForCobalt();
    expect(isUniversalFor(s.kind, { brand: s.brand, model: s.model })).toBe(
      false,
    );
  });

  it('still asks every oil question and completes', () => {
    const s = answerOilQuestions(oilForCobalt());
    expect(s.oilViscosity).toBe('5W-30');
    expect(s.oilType).toBe(OilType.SYNTHETIC);
    expect(s.oilVolumeMl).toBe(4_000);
    expect(s.step).toBe(WizardStep.TITLE);
  });
});

describe('2. MOTOR_OIL + specific make/model → compatibility is persisted', () => {
  function makeDb() {
    return {
      partModel: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({ id: 1 }),
      },
      brand: { upsert: jest.fn().mockResolvedValue({ id: 10 }) },
      carModel: { upsert: jest.fn().mockResolvedValue({ id: 20 }) },
    };
  }

  it('creates the brand/model link rows for a vehicle-specific oil', async () => {
    const db = makeDb();
    await persistVehicleLinks(db, 99, {
      isUniversal: false,
      vehicles: [{ brand: 'Chevrolet', model: 'Cobalt' }],
    });

    expect(db.brand.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: 'Chevrolet' } }),
    );
    expect(db.carModel.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { brandId_name: { brandId: 10, name: 'Cobalt' } },
      }),
    );
    expect(db.partModel.upsert).toHaveBeenCalled();
  });

  it('the buyer card reports real compatibility for it (not null)', () => {
    // A vehicle-specific oil DOES have a meaningful "does this fit?" answer, so
    // the card must not suppress it the way it does for a universal listing.
    expect(hasCompatibility(ProductKind.MOTOR_OIL, false)).toBe(true);
  });
});

describe('3. MOTOR_OIL + OTHER → isUniversal = true', () => {
  it('names no vehicle and is universal', () => {
    const s = oilViaOther();
    expect(s.kind).toBe(ProductKind.MOTOR_OIL);
    expect(s.brand).toBeNull();
    expect(s.model).toBeNull();
    expect(isUniversalFor(s.kind, { brand: s.brand, model: s.model })).toBe(
      true,
    );
  });

  it('the buyer card suppresses the compatibility question for it', () => {
    expect(hasCompatibility(ProductKind.MOTOR_OIL, true)).toBe(false);
  });
});

describe('4. MOTOR_OIL + OTHER → no stale vehicle from a previous session', () => {
  it('clears a vehicle collected earlier in the same dialogue', () => {
    // The seller started down the spare-part path, then went back and chose
    // "Другое". None of that vehicle may survive.
    const s = freshSession();
    selectBrand(s, CHEVROLET);
    selectModel(s, COBALT);
    expect(s.brand).toBe('Chevrolet');

    goBack(s); // → MODEL
    goBack(s); // → BRAND
    selectOtherBrand(s);
    s.categoryOptions = OTHER_OPTIONS;
    selectOtherCategory(s, 'motor-oil');

    expect(s.brand).toBeNull();
    expect(s.model).toBeNull();
    expect(isUniversalFor(s.kind, { brand: s.brand, model: s.model })).toBe(
      true,
    );
  });

  it('persistVehicleLinks writes NO link rows for a universal oil', async () => {
    const db = {
      partModel: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn(),
      },
      brand: { upsert: jest.fn() },
      carModel: { upsert: jest.fn() },
    };
    await persistVehicleLinks(db, 99, {
      isUniversal: true,
      vehicles: [],
    });
    // It still RECONCILES (drops any pre-existing rows) but creates none.
    expect(db.partModel.deleteMany).toHaveBeenCalled();
    expect(db.partModel.upsert).not.toHaveBeenCalled();
    expect(db.brand.upsert).not.toHaveBeenCalled();
  });
});

describe('5. switching specific → OTHER clears the compatibility', () => {
  it('drops the vehicle and becomes universal', () => {
    const s = oilForCobalt();
    expect(s.brand).toBe('Chevrolet');
    expect(isUniversalFor(s.kind, { brand: s.brand, model: s.model })).toBe(
      false,
    );

    // Walk back to BRAND and take the "Другое" branch instead.
    while (s.step !== WizardStep.BRAND && goBack(s).status === 'ok') {
      // walking back
    }
    selectOtherBrand(s);
    s.categoryOptions = OTHER_OPTIONS;
    selectOtherCategory(s, 'motor-oil');

    expect(s.brand).toBeNull();
    expect(s.model).toBeNull();
    expect(isUniversalFor(s.kind, { brand: s.brand, model: s.model })).toBe(
      true,
    );
  });
});

describe('6. switching OTHER → specific model clears the universal state', () => {
  it('re-acquires a vehicle and stops being universal', () => {
    const s = oilViaOther();
    expect(isUniversalFor(s.kind, { brand: s.brand, model: s.model })).toBe(
      true,
    );

    // Back to the brand list, then pick a real car and the oil category.
    while (s.step !== WizardStep.BRAND && goBack(s).status === 'ok') {
      // walking back
    }
    selectBrand(s, CHEVROLET);
    selectModel(s, COBALT);
    s.categoryOptions = CATEGORY_ROOTS;
    selectCategory(s, 'motor-oil', []);

    expect(s.kind).toBe(ProductKind.MOTOR_OIL);
    expect(s.brand).toBe('Chevrolet');
    expect(s.model).toBe('Cobalt');
    expect(isUniversalFor(s.kind, { brand: s.brand, model: s.model })).toBe(
      false,
    );
  });
});

describe('7. re-opening a draft preserves the correct state', () => {
  // A resumed session is rebuilt from the DRAFT's stored fields, so universality
  // must follow those fields and not be re-derived from the kind.
  it.each([
    [
      'a vehicle-specific oil stays specific',
      { kind: ProductKind.MOTOR_OIL, brand: 'Chevrolet', model: 'Cobalt' },
      false,
    ],
    [
      'a "Другое" oil stays universal',
      { kind: ProductKind.MOTOR_OIL, brand: null, model: null },
      true,
    ],
    [
      'a spare part is never universal once its vehicle is answered',
      { kind: ProductKind.SPARE_PART, brand: 'Chevrolet', model: 'Cobalt' },
      false,
    ],
  ])('%s', (_label, draft, expected) => {
    expect(
      isUniversalFor(draft.kind, { brand: draft.brand, model: draft.model }),
    ).toBe(expected);
  });

  it('a half-answered vehicle is treated as universal, not half-specific', () => {
    // Defensive: a brand with no model cannot produce a part_models row
    // (persistVehicleLinks needs both), so it must not claim to be specific.
    expect(
      isUniversalFor(ProductKind.MOTOR_OIL, {
        brand: 'Chevrolet',
        model: null,
      }),
    ).toBe(true);
  });
});

describe('SPARE_PART behaviour is unchanged', () => {
  it('is still vehicle-specific and still asks its own questions', () => {
    const s = freshSession();
    selectBrand(s, CHEVROLET);
    selectModel(s, COBALT);
    s.categoryOptions = CATEGORY_ROOTS;
    selectCategory(s, 'brake-system', []);

    // An ordinary category does NOT change the kind.
    expect(s.kind).toBe(ProductKind.SPARE_PART);
    expect(isUniversalFor(s.kind, { brand: s.brand, model: s.model })).toBe(
      false,
    );
    expect(hasCompatibility(s.kind, false)).toBe(true);
  });
});
