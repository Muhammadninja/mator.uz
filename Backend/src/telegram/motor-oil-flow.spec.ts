// Tests for the MOTOR-OIL branch of the product-creation wizard: reaching it via
// "Другое", the oil questionnaire's own step order, the free-text escape hatches,
// back-navigation through both, and the guarantee that spare-part concepts (GM /
// OEM numbers, vehicle fitment, part categories) never appear in this flow.
// Pure logic — no Telegraf, no I/O.

import { OilType, ProductKind } from '@prisma/client';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  beginQuestionnaire,
  selectBrand,
  selectOtherBrand,
  selectOtherCategory,
  selectOilViscosity,
  inputOilViscosity,
  selectOilType,
  selectOilVolume,
  inputOilVolume,
  inputTitle,
  inputDescription,
  skipDescription,
  inputPartNumber,
  choosePartNumberType,
  selectCategory,
  selectSubcategory,
  selectModel,
  inputPrice,
  goBack,
  previousStep,
  stepPrompt,
  previewLines,
  isUniversalKind,
  oilViscosityKeyboard,
  oilTypeKeyboard,
  oilVolumeKeyboard,
  otherCategoryKeyboard,
} from './product-wizard';
import {
  OIL_TYPES,
  OIL_VISCOSITIES,
  OIL_VOLUMES,
  normalizeViscosity,
  parseVolumeLitres,
} from './motor-oil-catalog';
import { WIZARD_BRANDS, WIZARD_OTHER_CATEGORIES } from './wizard-catalog';

const MOTOR_OIL = WIZARD_OTHER_CATEGORIES.findIndex(
  (c) => c.kind === ProductKind.MOTOR_OIL,
);
const FIVE_W_30 = OIL_VISCOSITIES.indexOf('5W-30');
const SYNTHETIC = OIL_TYPES.findIndex((t) => t.value === OilType.SYNTHETIC);
const FOUR_LITRES = OIL_VOLUMES.findIndex((v) => v.value === 4_000);

/** A session that has passed PHOTOS_FIRST and sits at the branch point (BRAND). */
function freshSession(): WizardSession {
  const s = new WizardSessionStore().start(1);
  beginQuestionnaire(s);
  return s;
}

/** Take the "Другое" → "Моторные масла" branch; lands on OIL_VISCOSITY. */
function sessionAtViscosity(): WizardSession {
  const s = freshSession();
  selectOtherBrand(s);
  selectOtherCategory(s, MOTOR_OIL);
  return s;
}

/** Answer every oil question with presets; lands on QUESTIONNAIRE_DONE. */
function sessionAtDone(): WizardSession {
  const s = sessionAtViscosity();
  selectOilViscosity(s, FIVE_W_30);
  selectOilType(s, SYNTHETIC);
  selectOilVolume(s, FOUR_LITRES);
  inputTitle(s, 'Mobil 1 ESP 5W-30 4L');
  inputDescription(s, 'Оригинал, Бельгия');
  inputPrice(s, '450 000');
  return s;
}

describe('reaching the motor-oil flow', () => {
  it('"Другое" at the BRAND step opens the other-category menu', () => {
    const s = freshSession();
    expect(selectOtherBrand(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.OTHER_CATEGORY);
    // The kind is NOT decided yet — the menu pick decides it.
    expect(s.kind).toBe(ProductKind.SPARE_PART);
  });

  it('"Моторные масла" sets the kind and starts the oil questionnaire', () => {
    const s = freshSession();
    selectOtherBrand(s);
    expect(selectOtherCategory(s, MOTOR_OIL).status).toBe('ok');
    expect(s.kind).toBe(ProductKind.MOTOR_OIL);
    expect(s.step).toBe(WizardStep.OIL_VISCOSITY);
  });

  it('the other-category menu offers exactly the registered categories', () => {
    const s = freshSession();
    selectOtherBrand(s);
    const labels = otherCategoryKeyboard(s)
      .reply_markup.inline_keyboard.flat()
      .map((b) => b.text)
      .filter((t) => t !== '⬅️ Назад');
    expect(labels).toEqual(WIZARD_OTHER_CATEGORIES.map((c) => c.label));
    expect(labels).toContain('Моторные масла');
  });

  it('rejects an out-of-range category index (forged payload)', () => {
    const s = freshSession();
    selectOtherBrand(s);
    expect(selectOtherCategory(s, 99).status).toBe('stale');
    expect(s.kind).toBe(ProductKind.SPARE_PART);
  });

  it('clears any vehicle already chosen before the seller switched to "Другое"', () => {
    // The seller picked a brand, walked back, then chose "Другое" instead.
    const s = freshSession();
    selectBrand(s, 0);
    selectModel(s, 0);
    goBack(s); // → MODEL
    goBack(s); // → BRAND
    selectOtherBrand(s);
    selectOtherCategory(s, MOTOR_OIL);
    expect(s.brand).toBeNull();
    expect(s.model).toBeNull();
    expect(s.category).toBeNull();
  });
});

describe('motor-oil happy path', () => {
  it('walks viscosity → type → volume → title → description → price', () => {
    const s = sessionAtDone();
    expect(s).toMatchObject({
      step: WizardStep.QUESTIONNAIRE_DONE,
      kind: ProductKind.MOTOR_OIL,
      oilViscosity: '5W-30',
      oilType: OilType.SYNTHETIC,
      oilVolumeMl: 4_000,
      title: 'Mobil 1 ESP 5W-30 4L',
      description: 'Оригинал, Бельгия',
      price: 450_000,
    });
  });

  it('never collects spare-part fields', () => {
    const s = sessionAtDone();
    expect(s.brand).toBeNull();
    expect(s.model).toBeNull();
    expect(s.category).toBeNull();
    expect(s.partNumber).toBeNull();
    expect(s.partNumberType).toBe('UNKNOWN');
  });

  it('the description step can be skipped, exactly as for spare parts', () => {
    const s = sessionAtViscosity();
    selectOilViscosity(s, FIVE_W_30);
    selectOilType(s, SYNTHETIC);
    selectOilVolume(s, FOUR_LITRES);
    inputTitle(s, 'ZIC X9 5W-30');
    expect(skipDescription(s).status).toBe('ok');
    expect(s.description).toBeNull();
    expect(s.step).toBe(WizardStep.PRICE);
  });

  it('the oil steps are never reachable in the spare-parts flow', () => {
    const s = freshSession();
    selectBrand(s, 0);
    // Spare parts go BRAND → MODEL, never to an oil step.
    expect(s.step).toBe(WizardStep.MODEL);
    expect(selectOilViscosity(s, FIVE_W_30).status).toBe('stale');
    expect(selectOilType(s, SYNTHETIC).status).toBe('stale');
    expect(selectOilVolume(s, FOUR_LITRES).status).toBe('stale');
  });

  it('spare-part steps are never reachable in the oil flow', () => {
    const s = sessionAtViscosity();
    expect(selectModel(s, 0).status).toBe('stale');
    expect(selectCategory(s, 0).status).toBe('stale');
    expect(choosePartNumberType(s, 'OEM').status).toBe('stale');
    expect(inputPartNumber(s, '96535062').status).toBe('stale');
  });
});

describe('"Другое" free-text branches', () => {
  it('a custom viscosity routes through the free-text step and normalizes it', () => {
    const s = sessionAtViscosity();
    expect(selectOilViscosity(s, 'custom').status).toBe('ok');
    expect(s.step).toBe(WizardStep.OIL_VISCOSITY_CUSTOM);
    expect(inputOilViscosity(s, '0w16').status).toBe('ok');
    expect(s.oilViscosity).toBe('0W-16'); // uppercased, dash inserted
    expect(s.step).toBe(WizardStep.OIL_TYPE);
  });

  it('rejects a viscosity that is not a SAE grade, keeping the seller on the step', () => {
    const s = sessionAtViscosity();
    selectOilViscosity(s, 'custom');
    const result = inputOilViscosity(s, 'очень густое');
    expect(result.status).toBe('invalid');
    expect(s.step).toBe(WizardStep.OIL_VISCOSITY_CUSTOM);
    expect(s.oilViscosity).toBeNull();
  });

  it('a custom volume is parsed from litres into millilitres', () => {
    const s = sessionAtViscosity();
    selectOilViscosity(s, FIVE_W_30);
    selectOilType(s, SYNTHETIC);
    expect(selectOilVolume(s, 'custom').status).toBe('ok');
    expect(s.step).toBe(WizardStep.OIL_VOLUME_CUSTOM);
    expect(inputOilVolume(s, '3,5 л').status).toBe('ok');
    expect(s.oilVolumeMl).toBe(3_500);
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('rejects a non-positive or absurd volume', () => {
    const s = sessionAtViscosity();
    selectOilViscosity(s, FIVE_W_30);
    selectOilType(s, SYNTHETIC);
    selectOilVolume(s, 'custom');
    expect(inputOilVolume(s, '0').status).toBe('invalid');
    expect(inputOilVolume(s, '-4').status).toBe('invalid');
    expect(inputOilVolume(s, '5000').status).toBe('invalid'); // 5000 л
    expect(s.oilVolumeMl).toBeNull();
  });

  it('picking a preset after taking the custom branch drops the detour', () => {
    const s = sessionAtViscosity();
    selectOilViscosity(s, 'custom'); // → OIL_VISCOSITY_CUSTOM
    goBack(s); // → OIL_VISCOSITY
    selectOilViscosity(s, FIVE_W_30);
    expect(s.viscosityIsCustom).toBe(false);
    expect(s.oilViscosity).toBe('5W-30');
    // The free-text step is no longer on the path.
    expect(s.step).toBe(WizardStep.OIL_TYPE);
    expect(previousStep(s)).toBe(WizardStep.OIL_VISCOSITY);
  });
});

describe('motor-oil back navigation', () => {
  it('walks the whole oil flow backwards in exactly the forward order', () => {
    const s = sessionAtDone();
    s.step = WizardStep.PRICE; // the last question the seller can return to
    const visited: WizardStep[] = [s.step];
    while (goBack(s).status === 'ok') visited.push(s.step);
    expect(visited).toEqual([
      WizardStep.PRICE,
      WizardStep.DESCRIPTION,
      WizardStep.TITLE,
      WizardStep.OIL_VOLUME,
      WizardStep.OIL_TYPE,
      WizardStep.OIL_VISCOSITY,
      WizardStep.OTHER_CATEGORY,
      WizardStep.BRAND,
    ]);
  });

  it('re-visits the free-text steps only when they were taken', () => {
    const custom = sessionAtViscosity();
    selectOilViscosity(custom, 'custom');
    inputOilViscosity(custom, '0W-16'); // → OIL_TYPE
    expect(previousStep(custom)).toBe(WizardStep.OIL_VISCOSITY_CUSTOM);

    const preset = sessionAtViscosity();
    selectOilViscosity(preset, FIVE_W_30); // → OIL_TYPE
    expect(previousStep(preset)).toBe(WizardStep.OIL_VISCOSITY);
  });

  it('going back preserves already-entered answers', () => {
    const s = sessionAtDone();
    s.step = WizardStep.PRICE;
    goBack(s);
    goBack(s); // → TITLE
    expect(s.oilViscosity).toBe('5W-30');
    expect(s.oilType).toBe(OilType.SYNTHETIC);
    expect(s.oilVolumeMl).toBe(4_000);
    expect(s.title).toBe('Mobil 1 ESP 5W-30 4L');
  });

  it('BRAND remains the first step of the oil flow (nothing before it)', () => {
    const s = sessionAtViscosity();
    s.step = WizardStep.BRAND;
    expect(previousStep(s)).toBeNull();
    expect(goBack(s).status).toBe('stale');
  });
});

describe('motor-oil prompts (Russian, oil-specific)', () => {
  it('asks each oil question in Russian with its catalog options', () => {
    const s = sessionAtViscosity();
    expect(stepPrompt(s).text).toContain('вязкость');
    expect(
      oilViscosityKeyboard(s)
        .reply_markup.inline_keyboard.flat()
        .map((b) => b.text),
    ).toEqual([...OIL_VISCOSITIES, 'Другое', '⬅️ Назад']);

    selectOilViscosity(s, FIVE_W_30);
    expect(stepPrompt(s).text).toContain('тип масла');
    expect(
      oilTypeKeyboard(s)
        .reply_markup.inline_keyboard.flat()
        .map((b) => b.text)
        .filter((t) => t !== '⬅️ Назад'),
    ).toEqual(['Синтетическое', 'Полусинтетическое', 'Минеральное']);

    selectOilType(s, SYNTHETIC);
    expect(stepPrompt(s).text).toContain('объём');
    expect(
      oilVolumeKeyboard(s)
        .reply_markup.inline_keyboard.flat()
        .map((b) => b.text),
    ).toEqual([...OIL_VOLUMES.map((v) => v.label), 'Другое', '⬅️ Назад']);
  });

  it('shows oil examples on the shared TITLE step', () => {
    const oil = sessionAtViscosity();
    selectOilViscosity(oil, FIVE_W_30);
    selectOilType(oil, SYNTHETIC);
    selectOilVolume(oil, FOUR_LITRES);
    const text = stepPrompt(oil).text;
    expect(text).toContain('Mobil 1 ESP 5W-30 4L');
    expect(text).not.toContain('амортизатор');

    // The same step still shows the spare-part example on the parts flow.
    const part = freshSession();
    selectBrand(part, 0);
    selectModel(part, 0);
    selectCategory(part, 0);
    selectSubcategory(part, 0);
    expect(stepPrompt(part).text).toContain('амортизатор');
  });
});

describe('preview lines per kind', () => {
  const base = {
    vehicleCategoryLabel: 'Тормозная система',
    partNumberLabel: 'OEM №',
    partNumber: '96535062',
    oilViscosity: '5W-30',
    oilType: OilType.SYNTHETIC,
    oilVolumeMl: 4_000,
  };

  it('an oil shows viscosity / type / volume and no spare-part lines', () => {
    const lines = previewLines(
      { ...base, kind: ProductKind.MOTOR_OIL },
      'Chevrolet Cobalt',
    ).join('\n');
    expect(lines).toContain('Вязкость');
    expect(lines).toContain('5W-30');
    expect(lines).toContain('Синтетическое');
    expect(lines).toContain('4 л');
    expect(lines).not.toContain('Автомобиль');
    expect(lines).not.toContain('Категория');
    expect(lines).not.toContain('96535062');
  });

  it('a spare part shows vehicle / category / number and no oil lines', () => {
    const lines = previewLines(
      { ...base, kind: ProductKind.SPARE_PART },
      'Chevrolet Cobalt',
    ).join('\n');
    expect(lines).toContain('Chevrolet Cobalt');
    expect(lines).toContain('Тормозная система');
    expect(lines).toContain('96535062');
    expect(lines).not.toContain('Вязкость');
    expect(lines).not.toContain('Объём');
  });

  it('renders an em dash for a missing oil attribute rather than "null"', () => {
    const lines = previewLines(
      {
        ...base,
        kind: ProductKind.MOTOR_OIL,
        oilViscosity: null,
        oilType: null,
        oilVolumeMl: null,
      },
      '—',
    ).join('\n');
    expect(lines).not.toContain('null');
    expect(lines.match(/—/g)?.length).toBe(3);
  });
});

describe('motor oils are universal by kind', () => {
  it('marks MOTOR_OIL universal and SPARE_PART not', () => {
    expect(isUniversalKind(ProductKind.MOTOR_OIL)).toBe(true);
    expect(isUniversalKind(ProductKind.SPARE_PART)).toBe(false);
  });

  it('the oil flow contains no compatibility step at all', () => {
    // The universality rule and the flow agree: there is nothing to ask, so the
    // seller is never given a compatibility question to answer.
    const s = sessionAtDone();
    const compatibilitySteps = [
      WizardStep.MODEL,
      WizardStep.CATEGORY,
      WizardStep.PART_NUMBER_TYPE,
      WizardStep.PART_NUMBER,
    ];
    // Walk the whole flow backwards and confirm none of them is on the path.
    s.step = WizardStep.PRICE;
    const visited: WizardStep[] = [s.step];
    while (goBack(s).status === 'ok') visited.push(s.step);
    for (const step of compatibilitySteps) expect(visited).not.toContain(step);
  });
});

describe('motor-oil catalog parsers', () => {
  it.each([
    ['5w30', '5W-30'],
    ['5W-30', '5W-30'],
    ['0w16', '0W-16'],
    [' 10W40 ', '10W-40'],
  ])('normalizes viscosity %s → %s', (raw, expected) => {
    expect(normalizeViscosity(raw)).toBe(expected);
  });

  it.each(['', 'W30', '5W', 'синтетика', '5-30', '999W999'])(
    'rejects viscosity %p',
    (raw) => {
      expect(normalizeViscosity(raw)).toBeNull();
    },
  );

  it.each([
    ['1', 1_000],
    ['4 л', 4_000],
    ['0,5', 500],
    ['3.5 l', 3_500],
    ['20 литров', 20_000],
  ])('parses volume %p → %i ml', (raw, expected) => {
    expect(parseVolumeLitres(raw)).toBe(expected);
  });

  it.each(['', '0', '-1', 'много', '201'])('rejects volume %p', (raw) => {
    expect(parseVolumeLitres(raw)).toBeNull();
  });

  it('every preset viscosity survives normalization unchanged (buttons ≡ typed)', () => {
    for (const v of OIL_VISCOSITIES) expect(normalizeViscosity(v)).toBe(v);
  });
});

// ── Rendered-UI tests ───────────────────────────────────────────────────────
// These assert the KEYBOARD the seller actually receives, not the flow tables.
// That distinction is the point: the "Другое" menu shipped with no "⬅️ Назад"
// button while every flow-level test passed, because OTHER_CATEGORY sat inside
// MOTOR_OIL's FLOWS entry — unreachable from the session standing on it, whose
// kind is still SPARE_PART at that moment. previousStep returned null and
// withBack silently omitted the row, trapping the seller on a dead-end screen.

/** Button labels of the keyboard a step renders, in Telegram's own order. */
function renderedButtons(session: WizardSession): string[] {
  const prompt = stepPrompt(session);
  if (!prompt.keyboard) return [];
  return prompt.keyboard.reply_markup.inline_keyboard
    .flat()
    .map((b) => (b as { text: string }).text);
}

describe('rendered keyboards — every step the seller can reach', () => {
  it('the BRAND keyboard renders every brand PLUS "Другое"', () => {
    const buttons = renderedButtons(freshSession());
    expect(buttons).toEqual([...WIZARD_BRANDS.map((b) => b.name), 'Другое']);
    // First step: nothing to go back to, so no Back row.
    expect(buttons).not.toContain('⬅️ Назад');
  });

  it('the "Другое" menu renders its categories AND a Back button', () => {
    // The regression: this screen used to render "Моторные масла" alone, with no
    // way back to the brand list short of /start.
    const s = freshSession();
    selectOtherBrand(s);
    expect(renderedButtons(s)).toEqual(['Моторные масла', '⬅️ Назад']);
  });

  it('every oil step renders its full option set plus Back', () => {
    const s = sessionAtViscosity();
    expect(renderedButtons(s)).toEqual([
      ...OIL_VISCOSITIES,
      'Другое',
      '⬅️ Назад',
    ]);

    selectOilViscosity(s, FIVE_W_30);
    expect(renderedButtons(s)).toEqual([
      ...OIL_TYPES.map((t) => t.label),
      '⬅️ Назад',
    ]);

    selectOilType(s, SYNTHETIC);
    expect(renderedButtons(s)).toEqual([
      ...OIL_VOLUMES.map((v) => v.label),
      'Другое',
      '⬅️ Назад',
    ]);
  });

  it('EVERY step of the oil flow except the first renders a Back button', () => {
    // Walks the whole flow backwards and re-renders each step, so a future step
    // that forgets its Back row fails here rather than in production.
    const s = sessionAtDone();
    s.step = WizardStep.PRICE;
    const visited: WizardStep[] = [s.step];
    while (goBack(s).status === 'ok') visited.push(s.step);

    expect(visited[visited.length - 1]).toBe(WizardStep.BRAND);
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

  it('Back from the "Другое" menu returns to the brand list', () => {
    const s = freshSession();
    selectOtherBrand(s);
    expect(goBack(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.BRAND);
    expect(renderedButtons(s)).toContain('Другое');
  });

  it('the full oil Back path mirrors the forward path exactly', () => {
    const s = sessionAtDone();
    s.step = WizardStep.PRICE;
    const visited: WizardStep[] = [s.step];
    while (goBack(s).status === 'ok') visited.push(s.step);
    expect(visited).toEqual([
      WizardStep.PRICE,
      WizardStep.DESCRIPTION,
      WizardStep.TITLE,
      WizardStep.OIL_VOLUME,
      WizardStep.OIL_TYPE,
      WizardStep.OIL_VISCOSITY,
      WizardStep.OTHER_CATEGORY,
      WizardStep.BRAND,
    ]);
  });

  it('the Back path through BOTH free-text branches is complete', () => {
    const s = sessionAtViscosity();
    selectOilViscosity(s, 'custom');
    inputOilViscosity(s, '0W-16');
    selectOilType(s, SYNTHETIC);
    selectOilVolume(s, 'custom');
    inputOilVolume(s, '3,5');

    const visited: WizardStep[] = [s.step];
    while (goBack(s).status === 'ok') visited.push(s.step);
    expect(visited).toEqual([
      WizardStep.TITLE,
      WizardStep.OIL_VOLUME_CUSTOM,
      WizardStep.OIL_VOLUME,
      WizardStep.OIL_TYPE,
      WizardStep.OIL_VISCOSITY_CUSTOM,
      WizardStep.OIL_VISCOSITY,
      WizardStep.OTHER_CATEGORY,
      WizardStep.BRAND,
    ]);
  });

  it('OTHER_CATEGORY never appears in the spare-parts flow', () => {
    // It is a shared-prefix step gated on the branch actually being taken, so a
    // spare-part seller must never walk back into the "Другое" menu.
    const s = freshSession();
    selectBrand(s, 0);
    selectModel(s, 0);
    selectCategory(s, 0);
    selectSubcategory(s, 0);
    inputTitle(s, 'Фильтр масляный');
    inputDescription(s, 'Новый');
    choosePartNumberType(s, 'OEM');
    inputPartNumber(s, '96535062');

    const visited: WizardStep[] = [s.step];
    while (goBack(s).status === 'ok') visited.push(s.step);
    expect(visited).not.toContain(WizardStep.OTHER_CATEGORY);
    expect(visited[visited.length - 1]).toBe(WizardStep.BRAND);
  });
});

describe('callback payloads stay within Telegram limits', () => {
  it('every rendered payload is unique per step and under 64 bytes', () => {
    const s = sessionAtViscosity();
    const steps = [
      WizardStep.OTHER_CATEGORY,
      WizardStep.OIL_VISCOSITY,
      WizardStep.OIL_TYPE,
      WizardStep.OIL_VOLUME,
    ];
    for (const step of steps) {
      s.step = step;
      const prompt = stepPrompt(s);
      const payloads = (prompt.keyboard?.reply_markup.inline_keyboard ?? [])
        .flat()
        .map((b) => (b as { callback_data: string }).callback_data);
      // Telegram rejects callback_data over 64 BYTES (not characters).
      for (const p of payloads) {
        expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(64);
      }
      // A duplicate payload within one keyboard would make two buttons act alike.
      expect(new Set(payloads).size).toBe(payloads.length);
    }
  });

  it('no keyboard exceeds Telegram’s 8-buttons-per-row limit', () => {
    const s = sessionAtViscosity();
    for (const step of [WizardStep.OIL_VISCOSITY, WizardStep.OIL_VOLUME]) {
      s.step = step;
      const rows = stepPrompt(s).keyboard?.reply_markup.inline_keyboard ?? [];
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(8);
    }
  });
});
