// Tests for the ANTIFREEZE branch of the product-creation wizard: reaching it
// through "Другое" → "Что продаёте?", the single question it asks (a WEIGHT in
// kilograms, never a piece count), its free-text branch, back-navigation through
// the whole path, and the guarantee that no motor-oil concept — least of all an
// oil TYPE, which selects an oil's MXIK — ever leaks into it.
// Pure logic — no Telegraf, no I/O.

import { OilType, ProductKind } from '@prisma/client';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  beginQuestionnaire,
  selectBrand,
  selectModel,
  selectOtherBrand,
  selectOtherKind,
  selectOtherCategory,
  selectAntifreezeWeight,
  inputAntifreezeWeight,
  selectOilType,
  selectOilViscosity,
  selectOilVolume,
  inputTitle,
  inputDescription,
  inputPrice,
  choosePartNumberType,
  goBack,
  previousStep,
  stepPrompt,
  previewLines,
  isUniversalFor,
  antifreezeWeightKeyboard,
} from './product-wizard';
import {
  ANTIFREEZE_WEIGHTS,
  parseWeightKg,
  formatWeight,
} from './antifreeze-catalog';
import { unitOf } from '../common/product-kind';

/** The antifreeze category as the bot reads it from the live tree. */
const ANTIFREEZE_ANCHOR = {
  vehicleCategoryId: 'maintenance-and-fluids',
  categoryId: 'antifreeze',
  fiscal: null,
};

const TWO_AND_A_HALF_KG = ANTIFREEZE_WEIGHTS.findIndex(
  (w) => w.value === 2_500,
);

/** A session that has passed PHOTOS_FIRST and sits at the branch point (BRAND). */
function freshSession(): WizardSession {
  const s = new WizardSessionStore().start(1);
  beginQuestionnaire(s);
  return s;
}

/** "Другое" → "Что продаёте?" → "Антифриз"; lands on ANTIFREEZE_WEIGHT. */
function sessionAtWeight(): WizardSession {
  const s = freshSession();
  selectOtherBrand(s);
  selectOtherKind(s, ProductKind.ANTIFREEZE, ANTIFREEZE_ANCHOR);
  return s;
}

/** Answer everything with presets; lands on QUESTIONNAIRE_DONE. */
function sessionAtDone(): WizardSession {
  const s = sessionAtWeight();
  selectAntifreezeWeight(s, TWO_AND_A_HALF_KG);
  inputTitle(s, 'Felix Carbox G12 красный');
  inputDescription(s, 'Готовый раствор, −40 °C');
  inputPrice(s, '85 000');
  return s;
}

/** Button labels of the keyboard the session's current step renders. */
function renderedButtons(session: WizardSession): string[] {
  const prompt = stepPrompt(session);
  return (prompt.keyboard?.reply_markup.inline_keyboard ?? [])
    .flat()
    .map((b) => (b as { text: string }).text);
}

describe('reaching the antifreeze flow', () => {
  it('"Другое" → "Антифриз" starts the antifreeze questionnaire', () => {
    const s = freshSession();
    selectOtherBrand(s);
    expect(s.step).toBe(WizardStep.OTHER_KIND);

    expect(
      selectOtherKind(s, ProductKind.ANTIFREEZE, ANTIFREEZE_ANCHOR).status,
    ).toBe('ok');
    expect(s.kind).toBe(ProductKind.ANTIFREEZE);
    // Straight to its own question: antifreeze has a FIXED category, so it never
    // sees the oil-taxonomy menu.
    expect(s.step).toBe(WizardStep.ANTIFREEZE_WEIGHT);
  });

  it('files the listing under the EXISTING antifreeze category', () => {
    const s = sessionAtWeight();
    // Not a parallel taxonomy: the `antifreeze` leaf of the buyer tree, with the
    // root it hangs under, so the pair passes the server-side lineage check.
    expect(s.categoryId).toBe('antifreeze');
    expect(s.vehicleCategoryId).toBe('maintenance-and-fluids');
  });

  it('is universal and collects no vehicle, number or oil attribute', () => {
    const s = sessionAtDone();
    expect(s.brand).toBeNull();
    expect(s.model).toBeNull();
    expect(isUniversalFor(s.kind, { brand: s.brand, model: s.model })).toBe(
      true,
    );
    expect(s.partNumber).toBeNull();
    expect(s.partNumberType).toBe('UNKNOWN');
    // THE fiscal invariant: no oil type, so an antifreeze can never be
    // fiscalized off one of the three motor-oil MXIKs.
    expect(s.oilType).toBeNull();
    expect(s.oilViscosity).toBeNull();
    expect(s.oilVolumeMl).toBeNull();
  });

  it('clears a vehicle chosen before the seller switched to "Другое"', () => {
    const s = freshSession();
    selectBrand(s, 0);
    selectModel(s, 0);
    goBack(s); // → MODEL
    goBack(s); // → BRAND
    selectOtherBrand(s);
    selectOtherKind(s, ProductKind.ANTIFREEZE, ANTIFREEZE_ANCHOR);
    expect(s.brand).toBeNull();
    expect(s.model).toBeNull();
    expect(s.category).toBeNull();
  });

  it('oil steps are not reachable in the antifreeze flow', () => {
    const s = sessionAtWeight();
    expect(selectOilType(s, 0).status).toBe('stale');
    expect(selectOilViscosity(s, 0).status).toBe('stale');
    expect(selectOilVolume(s, 0).status).toBe('stale');
    expect(choosePartNumberType(s, 'OEM').status).toBe('stale');
  });

  it('the weight step is not reachable in the oil flow', () => {
    const s = freshSession();
    selectOtherBrand(s);
    selectOtherKind(s, ProductKind.MOTOR_OIL);
    s.categoryOptions = [{ id: 'motorcycle-oil', name: 'Мотоциклетные масла' }];
    selectOtherCategory(s, 'motorcycle-oil');
    // The oil questionnaire starts at the viscosity: the composition, where one
    // applies, is the category itself rather than a step.
    expect(s.step).toBe(WizardStep.OIL_VISCOSITY);
    expect(selectAntifreezeWeight(s, 0).status).toBe('stale');
  });
});

describe('the quantity is a WEIGHT in kilograms, never a piece count', () => {
  it("declares KG as the kind's unit", () => {
    expect(unitOf(ProductKind.ANTIFREEZE)).toBe('KG');
    expect(unitOf(ProductKind.ANTIFREEZE)).not.toBe('PCS');
  });

  it('offers the preset weights in kg plus the free-text escape hatch', () => {
    const buttons = renderedButtons(sessionAtWeight());
    expect(buttons).toEqual([
      '1 кг',
      '2.5 кг',
      '5 кг',
      '10 кг',
      'Другое',
      '⬅️ Назад',
    ]);
    // No button anywhere on this screen says "шт".
    expect(buttons.join(' ')).not.toContain('шт');
  });

  it('asks the question in kilograms', () => {
    expect(stepPrompt(sessionAtWeight()).text).toContain('кг');
    expect(stepPrompt(sessionAtWeight()).text).not.toContain('шт');
  });

  it('stores a preset weight in GRAMS', () => {
    const s = sessionAtWeight();
    expect(selectAntifreezeWeight(s, TWO_AND_A_HALF_KG).status).toBe('ok');
    // 2.5 кг is an exact integer number of grams — no float anywhere.
    expect(s.antifreezeWeightG).toBe(2_500);
    expect(s.weightIsCustom).toBe(false);
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('rejects a weight index that was never offered', () => {
    const s = sessionAtWeight();
    expect(selectAntifreezeWeight(s, 99).status).toBe('stale');
    expect(s.antifreezeWeightG).toBeNull();
  });

  it('accepts a FRACTIONAL typed weight through the "Другое" branch', () => {
    const s = sessionAtWeight();
    expect(selectAntifreezeWeight(s, 'custom').status).toBe('ok');
    expect(s.step).toBe(WizardStep.ANTIFREEZE_WEIGHT_CUSTOM);
    expect(inputAntifreezeWeight(s, '3,7 кг').status).toBe('ok');
    expect(s.antifreezeWeightG).toBe(3_700);
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('keeps the seller on the step when the weight cannot be read', () => {
    const s = sessionAtWeight();
    selectAntifreezeWeight(s, 'custom');
    const result = inputAntifreezeWeight(s, 'две канистры');
    expect(result.status).toBe('invalid');
    expect(s.step).toBe(WizardStep.ANTIFREEZE_WEIGHT_CUSTOM);
    expect(s.antifreezeWeightG).toBeNull();
  });

  it('picking a preset after the custom branch drops the detour', () => {
    const s = sessionAtWeight();
    selectAntifreezeWeight(s, 'custom'); // → the free-text step
    goBack(s); // → ANTIFREEZE_WEIGHT
    selectAntifreezeWeight(s, TWO_AND_A_HALF_KG);
    expect(s.weightIsCustom).toBe(false);
    expect(s.step).toBe(WizardStep.TITLE);
    expect(previousStep(s)).toBe(WizardStep.ANTIFREEZE_WEIGHT);
  });
});

describe('antifreeze back navigation', () => {
  it('walks the whole path backwards in exactly the forward order', () => {
    const s = sessionAtDone();
    s.step = WizardStep.PRICE;
    const visited: WizardStep[] = [s.step];
    while (goBack(s).status === 'ok') visited.push(s.step);
    expect(visited).toEqual([
      WizardStep.PRICE,
      WizardStep.DESCRIPTION,
      WizardStep.TITLE,
      WizardStep.ANTIFREEZE_WEIGHT,
      // The kind question — NOT the oil-taxonomy menu, which this branch never
      // visited.
      WizardStep.OTHER_KIND,
      WizardStep.BRAND,
    ]);
    expect(visited).not.toContain(WizardStep.OTHER_CATEGORY);
  });

  it('every step but the first renders a Back button, and re-renders its options', () => {
    const s = sessionAtDone();
    s.step = WizardStep.PRICE;
    const visited: WizardStep[] = [s.step];
    while (goBack(s).status === 'ok') visited.push(s.step);

    for (const step of visited) {
      s.step = step;
      const buttons = renderedButtons(s);
      if (step === WizardStep.BRAND) {
        expect(buttons).not.toContain('⬅️ Назад');
      } else {
        expect(buttons).toContain('⬅️ Назад');
      }
    }
  });

  it('the weight step still shows its buttons when returned to', () => {
    const s = sessionAtDone();
    s.step = WizardStep.TITLE;
    goBack(s);
    expect(s.step).toBe(WizardStep.ANTIFREEZE_WEIGHT);
    expect(renderedButtons(s)).toEqual([
      '1 кг',
      '2.5 кг',
      '5 кг',
      '10 кг',
      'Другое',
      '⬅️ Назад',
    ]);
    // Going back preserves the answer — it is only re-askable, not lost.
    expect(s.antifreezeWeightG).toBe(2_500);
  });

  it('re-visits the free-text step only when it was taken', () => {
    const custom = sessionAtWeight();
    selectAntifreezeWeight(custom, 'custom');
    inputAntifreezeWeight(custom, '3.7');
    expect(previousStep(custom)).toBe(WizardStep.ANTIFREEZE_WEIGHT_CUSTOM);

    const preset = sessionAtWeight();
    selectAntifreezeWeight(preset, TWO_AND_A_HALF_KG);
    expect(previousStep(preset)).toBe(WizardStep.ANTIFREEZE_WEIGHT);
  });

  it('Back to "Что продаёте?" lets the seller switch to motor oil cleanly', () => {
    const s = sessionAtWeight();
    selectAntifreezeWeight(s, TWO_AND_A_HALF_KG);
    goBack(s); // → ANTIFREEZE_WEIGHT
    goBack(s); // → OTHER_KIND
    expect(s.step).toBe(WizardStep.OTHER_KIND);
    expect(renderedButtons(s)).toEqual([
      '🛢 Моторное масло',
      '🧊 Антифриз',
      '⬅️ Назад',
    ]);

    selectOtherKind(s, ProductKind.MOTOR_OIL);
    expect(s.kind).toBe(ProductKind.MOTOR_OIL);
    // The abandoned branch's attribute does not follow the seller across.
    expect(s.antifreezeWeightG).toBeNull();
    expect(s.step).toBe(WizardStep.OTHER_CATEGORY);
  });

  it('Back to BRAND and picking a car returns to the spare-parts flow', () => {
    const s = sessionAtWeight();
    selectAntifreezeWeight(s, TWO_AND_A_HALF_KG);
    while (s.step !== WizardStep.BRAND && goBack(s).status === 'ok') {
      // walk back to the branch point
    }
    selectBrand(s, 0);
    expect(s.kind).toBe(ProductKind.SPARE_PART);
    expect(s.antifreezeWeightG).toBeNull();
    expect(s.weightIsCustom).toBe(false);
    expect(s.step).toBe(WizardStep.MODEL);
  });

  it('survives several forward → back → forward → back cycles', () => {
    const s = sessionAtWeight();
    for (let i = 0; i < 3; i++) {
      const index = i % 2 === 0 ? TWO_AND_A_HALF_KG : 0;
      selectAntifreezeWeight(s, index);
      expect(s.step).toBe(WizardStep.TITLE);
      expect(s.antifreezeWeightG).toBe(ANTIFREEZE_WEIGHTS[index].value);

      goBack(s);
      expect(s.step).toBe(WizardStep.ANTIFREEZE_WEIGHT);
      expect(renderedButtons(s)).toContain('2.5 кг');
      // The kind and its category survive every round trip.
      expect(s.kind).toBe(ProductKind.ANTIFREEZE);
      expect(s.categoryId).toBe('antifreeze');
    }
  });
});

describe('antifreeze preview', () => {
  const base = {
    vehicleCategoryLabel: 'Обслуживание и жидкости',
    partNumberLabel: 'OEM №',
    partNumber: '96535062',
    oilViscosity: null,
    oilType: null,
    oilVolumeMl: null,
    antifreezeWeightG: null,
  };

  it('shows the weight in kg and no oil, vehicle or part-number line', () => {
    const lines = previewLines(
      { ...base, kind: ProductKind.ANTIFREEZE, antifreezeWeightG: 2_500 },
      'Chevrolet Cobalt',
    ).join('\n');
    expect(lines).toContain('Вес');
    expect(lines).toContain('2.5 кг');
    expect(lines).not.toContain('шт');
    expect(lines).not.toContain('Вязкость');
    expect(lines).not.toContain('Автомобиль');
    expect(lines).not.toContain('96535062');
  });

  it('renders an em dash for a missing weight rather than "null"', () => {
    const lines = previewLines(
      { ...base, kind: ProductKind.ANTIFREEZE, antifreezeWeightG: null },
      '—',
    ).join('\n');
    expect(lines).not.toContain('null');
    expect(lines).toContain('—');
  });

  it('an oil preview is unaffected by the new kind', () => {
    const lines = previewLines(
      {
        ...base,
        kind: ProductKind.MOTOR_OIL,
        isUniversal: true,
        oilViscosity: '5W-30',
        oilType: OilType.SYNTHETIC,
        oilVolumeMl: 4_000,
      },
      'Chevrolet Cobalt',
    ).join('\n');
    expect(lines).toContain('5W-30');
    expect(lines).toContain('4 л');
    expect(lines).not.toContain('Вес');
  });
});

describe('antifreeze weight parsing and formatting', () => {
  it.each([
    ['1', 1_000],
    ['2.5', 2_500],
    ['2,5 кг', 2_500],
    ['5 kg', 5_000],
    ['10 килограмм', 10_000],
    [' 0,5 ', 500],
  ])('parses %p → %i g', (raw, expected) => {
    expect(parseWeightKg(raw)).toBe(expected);
  });

  it.each(['', '0', '-1', 'много', '221', '0.0001', 'кг'])(
    'rejects %p',
    (raw) => {
      expect(parseWeightKg(raw)).toBeNull();
    },
  );

  it.each([
    [1_000, '1 кг'],
    [2_500, '2.5 кг'],
    [3_700, '3.7 кг'],
    [500, '500 г'],
    [10_000, '10 кг'],
  ])('formats %i g as %p', (grams, label) => {
    expect(formatWeight(grams)).toBe(label);
  });

  it('every preset survives a round trip through the parser (buttons ≡ typed)', () => {
    for (const w of ANTIFREEZE_WEIGHTS) {
      expect(parseWeightKg(String(w.value / 1000))).toBe(w.value);
    }
  });
});
