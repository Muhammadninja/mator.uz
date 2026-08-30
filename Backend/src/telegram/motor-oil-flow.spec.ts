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
  selectOtherKind,
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
  isUniversalFor,
  oilViscosityKeyboard,
  oilTypeKeyboard,
  oilVolumeKeyboard,
  otherCategoryKeyboard,
  otherKindKeyboard,
  type CategoryOption,
} from './product-wizard';
import {
  OIL_TYPES,
  OIL_VISCOSITIES,
  OIL_VOLUMES,
  normalizeViscosity,
  parseVolumeLitres,
} from './motor-oil-catalog';
import { WIZARD_BRANDS } from './wizard-catalog';
import {
  CategoryAnchor,
  MOTOR_OIL_CATEGORY_IDS,
} from '../catalog/categories/category-map';
import { resolveOilFiscalCodes } from '../common/fiscal.util';

/**
 * The "Другое" menu is now the ADMIN-MANAGED children of the `other` category,
 * loaded by the caller. These stand in for what the bot would have fetched.
 * 'motor-oil' is the anchor id that starts the oil questionnaire; the others are
 * pure taxonomy that keep the same questionnaire.
 */
const OTHER_OPTIONS = [
  { id: 'motor-oil', name: 'Моторные масла', kind: ProductKind.MOTOR_OIL },
  { id: 'motorcycle-oil', name: 'Мотоциклетные масла' },
];
const MOTOR_OIL = 'motor-oil';

/**
 * The four categories offered under "Моторное масло". Built from the shared
 * anchor list so the spec cannot drift from what the wizard actually opens.
 */
const OIL_CATEGORY_OPTIONS: CategoryOption[] = MOTOR_OIL_CATEGORY_IDS.map(
  (id) => ({
    id,
    name: id,
    vehicleCategoryEnum: null,
    mainCategoryEnum: null,
    kind: ProductKind.MOTOR_OIL,
  }),
);

/** Put a session on the OTHER_CATEGORY step with the menu rendered. */
function withOtherOptions(s: WizardSession): WizardSession {
  s.categoryOptions = OTHER_OPTIONS;
  return s;
}
const FIVE_W_30 = OIL_VISCOSITIES.indexOf('5W-30');
const SYNTHETIC = OIL_TYPES.findIndex((t) => t.value === OilType.SYNTHETIC);
const FOUR_LITRES = OIL_VOLUMES.findIndex((v) => v.value === 4_000);

/** A session that has passed PHOTOS_FIRST and sits at the branch point (BRAND). */
function freshSession(): WizardSession {
  const s = new WizardSessionStore().start(1);
  beginQuestionnaire(s);
  return s;
}

/**
 * Take the "Другое" → "Что продаёте?" → "Моторное масло" branch and stand on the
 * category menu — the FOUR compositions, which is the first oil question now
 * that the type is the category rather than a step of its own.
 */
function sessionAtOilCategory(): WizardSession {
  const s = freshSession();
  selectOtherBrand(s);
  selectOtherKind(s, ProductKind.MOTOR_OIL);
  s.categoryOptions = OIL_CATEGORY_OPTIONS;
  return s;
}

/**
 * …and one question further on: a composition picked (which DERIVES oilType),
 * standing at the viscosity question.
 */
function sessionAtViscosity(
  categoryId: string = CategoryAnchor.SYNTHETIC_MOTOR_OIL,
): WizardSession {
  const s = sessionAtOilCategory();
  selectOtherCategory(s, categoryId);
  return s;
}

/** Answer every oil question with presets; lands on QUESTIONNAIRE_DONE. */
function sessionAtDone(): WizardSession {
  const s = sessionAtViscosity();
  selectOilViscosity(s, FIVE_W_30);
  selectOilVolume(s, FOUR_LITRES);
  inputTitle(s, 'Mobil 1 ESP 5W-30 4L');
  inputDescription(s, 'Оригинал, Бельгия');
  inputPrice(s, '450 000');
  return s;
}

describe('reaching the motor-oil flow', () => {
  it('"Другое" at the BRAND step asks WHAT is being sold', () => {
    const s = freshSession();
    expect(selectOtherBrand(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.OTHER_KIND);
    // The kind is NOT decided yet — the "Что продаёте?" answer decides it.
    expect(s.kind).toBe(ProductKind.SPARE_PART);
  });

  it('"Моторное масло" sets the kind and opens the oil taxonomy menu', () => {
    const s = freshSession();
    selectOtherBrand(s);
    expect(selectOtherKind(s, ProductKind.MOTOR_OIL).status).toBe('ok');
    expect(s.kind).toBe(ProductKind.MOTOR_OIL);
    expect(s.step).toBe(WizardStep.OTHER_CATEGORY);
  });

  it('"Что продаёте?" offers exactly the non-vehicle kinds', () => {
    const s = freshSession();
    selectOtherBrand(s);
    const labels = otherKindKeyboard(s)
      .reply_markup.inline_keyboard.flat()
      .map((b) => b.text);
    expect(labels).toEqual(['🛢 Моторное масло', '🧊 Антифриз', '⬅️ Назад']);
  });

  it('the composition pick starts the oil questionnaire at the VISCOSITY', () => {
    const s = freshSession();
    selectOtherBrand(s);
    selectOtherKind(s, ProductKind.MOTOR_OIL);
    s.categoryOptions = OIL_CATEGORY_OPTIONS;
    expect(
      selectOtherCategory(s, CategoryAnchor.SYNTHETIC_MOTOR_OIL).status,
    ).toBe('ok');
    expect(s.kind).toBe(ProductKind.MOTOR_OIL);
    // The composition WAS the question — it is the category the seller just
    // picked — so the next thing asked is the viscosity, not the type again.
    expect(s.step).toBe(WizardStep.OIL_VISCOSITY);
    expect(s.oilType).toBe(OilType.SYNTHETIC);
    // "Другое" means NO specific vehicle, so the listing is universal and the
    // chosen composition is stored as its category.
    expect(s.brand).toBeNull();
    expect(s.model).toBeNull();
    expect(s.categoryId).toBe(CategoryAnchor.SYNTHETIC_MOTOR_OIL);
  });

  it('the other-category menu offers exactly the registered categories', () => {
    const s = freshSession();
    selectOtherBrand(s);
    selectOtherKind(s, ProductKind.MOTOR_OIL);
    withOtherOptions(s);
    const labels = otherCategoryKeyboard(s)
      .reply_markup.inline_keyboard.flat()
      .map((b) => b.text)
      .filter((t) => t !== '⬅️ Назад');
    // Built from the ADMIN-MANAGED options the caller loaded, so an admin adding
    // "Мотоциклетные масла" makes it appear with no redeploy.
    expect(labels).toEqual(OTHER_OPTIONS.map((c) => c.name));
    expect(labels).toContain('Моторные масла');
  });

  it('rejects a forged category id that was never offered', () => {
    const s = freshSession();
    selectOtherBrand(s);
    selectOtherKind(s, ProductKind.MOTOR_OIL);
    withOtherOptions(s);
    // Resolved against the rendered options, so an arbitrary id matches nothing.
    expect(selectOtherCategory(s, 'not-a-category').status).toBe('stale');
    expect(s.step).toBe(WizardStep.OTHER_CATEGORY);
    expect(s.categoryId).toBeNull();
  });

  it('clears any vehicle already chosen before the seller switched to "Другое"', () => {
    // The seller picked a brand, walked back, then chose "Другое" instead.
    const s = freshSession();
    selectBrand(s, 0);
    selectModel(s, 0);
    goBack(s); // → MODEL
    goBack(s); // → BRAND
    selectOtherBrand(s);
    selectOtherKind(s, ProductKind.MOTOR_OIL);
    withOtherOptions(s);
    selectOtherCategory(s, MOTOR_OIL);
    expect(s.brand).toBeNull();
    expect(s.model).toBeNull();
    expect(s.category).toBeNull();
  });
});

describe('motor-oil happy path', () => {
  it('walks type → viscosity → volume → title → description → price', () => {
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
    expect(s.step).toBe(WizardStep.OIL_VISCOSITY);
    expect(selectModel(s, 0).status).toBe('stale');
    expect(selectCategory(s, 'brake-system').status).toBe('stale');
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
    expect(s.step).toBe(WizardStep.OIL_VOLUME);
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
    expect(selectOilVolume(s, 'custom').status).toBe('ok');
    expect(s.step).toBe(WizardStep.OIL_VOLUME_CUSTOM);
    expect(inputOilVolume(s, '3,5 л').status).toBe('ok');
    expect(s.oilVolumeMl).toBe(3_500);
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('rejects a non-positive or absurd volume', () => {
    const s = sessionAtViscosity();
    selectOilViscosity(s, FIVE_W_30);
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
    expect(s.step).toBe(WizardStep.OIL_VOLUME);
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
      WizardStep.OIL_VISCOSITY,
      WizardStep.OTHER_CATEGORY,
      WizardStep.OTHER_KIND,
      WizardStep.BRAND,
    ]);
  });

  it('re-visits the free-text steps only when they were taken', () => {
    const custom = sessionAtViscosity();
    selectOilViscosity(custom, 'custom');
    inputOilViscosity(custom, '0W-16'); // → OIL_VOLUME
    expect(previousStep(custom)).toBe(WizardStep.OIL_VISCOSITY_CUSTOM);

    const preset = sessionAtViscosity();
    selectOilViscosity(preset, FIVE_W_30); // → OIL_VOLUME
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
    // The composition is asked as a CATEGORY (the four options), so the flow's
    // own first prompt is the viscosity.
    const s = sessionAtViscosity();
    expect(stepPrompt(s).text).toContain('вязкость');
    expect(
      oilViscosityKeyboard(s)
        .reply_markup.inline_keyboard.flat()
        .map((b) => b.text),
    ).toEqual([...OIL_VISCOSITIES, 'Другое', '⬅️ Назад']);

    selectOilViscosity(s, FIVE_W_30);
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
    selectOilVolume(oil, FOUR_LITRES);
    const text = stepPrompt(oil).text;
    expect(text).toContain('Mobil 1 ESP 5W-30 4L');
    expect(text).not.toContain('амортизатор');

    // The same step still shows the spare-part example on the parts flow.
    const part = freshSession();
    selectBrand(part, 0);
    selectModel(part, 0);
    part.categoryOptions = [{ id: 'brake-system', name: 'Тормозная система' }];
    selectCategory(part, 'brake-system', [{ id: 'brakes', name: 'Тормоза' }]);
    selectSubcategory(part, 'brakes', []);
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
    antifreezeWeightG: null,
  };

  it('an oil shows viscosity / type / volume and no spare-part lines', () => {
    const lines = previewLines(
      // A "Другое" oil: universal, so no vehicle line even though one is passed.
      { ...base, kind: ProductKind.MOTOR_OIL, isUniversal: true },
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
        isUniversal: true,
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
  it('marks a "Другое" oil universal and a vehicle-specific one NOT', () => {
    const noVehicle = { brand: null, model: null };
    const cobalt = { brand: 'Chevrolet', model: 'Cobalt' };
    // Universality is a property of the LISTING, not of the kind.
    expect(isUniversalFor(ProductKind.MOTOR_OIL, noVehicle)).toBe(true);
    expect(isUniversalFor(ProductKind.MOTOR_OIL, cobalt)).toBe(false);
    // SPARE_PART is unchanged: a vehicle is always collected, so it is never
    // universal once answered.
    expect(isUniversalFor(ProductKind.SPARE_PART, cobalt)).toBe(false);
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

/**
 * The CHOSEN CATEGORY selects the listing's MXIK / package code.
 *
 * The composition used to be a question of its own; it is now the category, and
 * `oilType` — still the single input to the registry's codes — is DERIVED from
 * it. So the linkage under test is category → oilType → codes, and the property
 * that matters is unchanged: each composition gets its own code, and a seller
 * who walks back and picks a different one takes the new code with them.
 */
describe('the chosen CATEGORY picks the listing\'s IKPU', () => {
  it.each([
    [CategoryAnchor.SYNTHETIC_MOTOR_OIL, OilType.SYNTHETIC, '02710005001000000', '1282037'],
    [CategoryAnchor.SEMI_SYNTHETIC_MOTOR_OIL, OilType.SEMI_SYNTHETIC, '02710005002000000', '1282031'],
    [CategoryAnchor.MINERAL_MOTOR_OIL, OilType.MINERAL, '02710005003000000', '1282581'],
  ])('%s → %s → %s / %s', (categoryId, type, mxik, packageCode) => {
    const s = sessionAtOilCategory();
    expect(selectOtherCategory(s, categoryId as string).status).toBe('ok');
    expect(s.categoryId).toBe(categoryId);
    // Derived, never asked — the seller answered a category, not a type.
    expect(s.oilType).toBe(type);
    expect(resolveOilFiscalCodes(s.oilType)).toEqual({ mxik, packageCode });
  });

  it('transmission oil takes NO motor-oil code', () => {
    // It denotes no base composition, so deriving one would fiscalize it under
    // a motor-oil MXIK. It carries its own category codes instead.
    const s = sessionAtOilCategory();
    expect(
      selectOtherCategory(s, CategoryAnchor.TRANSMISSION_OIL).status,
    ).toBe('ok');
    expect(s.categoryId).toBe(CategoryAnchor.TRANSMISSION_OIL);
    expect(s.oilType).toBeNull();
    expect(resolveOilFiscalCodes(s.oilType)).toBeNull();
  });

  it('re-answering the category after "⬅️ Назад" moves the codes with it', () => {
    // The regression this guards: a seller who walks back and changes the
    // composition keeps the previous one's IKPU.
    const s = sessionAtOilCategory();
    selectOtherCategory(s, CategoryAnchor.SYNTHETIC_MOTOR_OIL);
    expect(s.oilType).toBe(OilType.SYNTHETIC);

    goBack(s);
    s.categoryOptions = OIL_CATEGORY_OPTIONS;
    selectOtherCategory(s, CategoryAnchor.MINERAL_MOTOR_OIL);
    expect(s.oilType).toBe(OilType.MINERAL);
    expect(resolveOilFiscalCodes(s.oilType)).toEqual({
      mxik: '02710005003000000',
      packageCode: '1282581',
    });
  });

  it('viscosity does not affect the code', () => {
    // Every grade of one composition is one fiscal product.
    const codes = OIL_VISCOSITIES.map((grade) => {
      const s = sessionAtViscosity(CategoryAnchor.SYNTHETIC_MOTOR_OIL);
      selectOilViscosity(s, OIL_VISCOSITIES.indexOf(grade));
      return resolveOilFiscalCodes(s.oilType);
    });
    for (const c of codes) {
      expect(c).toEqual({ mxik: '02710005001000000', packageCode: '1282037' });
    }
  });
});

/** The button labels the current step renders, in order. */
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
    selectOtherKind(s, ProductKind.MOTOR_OIL);
    withOtherOptions(s);
    expect(renderedButtons(s)).toEqual([
      ...OTHER_OPTIONS.map((c) => c.name),
      '⬅️ Назад',
    ]);
  });

  it('every oil step renders its full option set plus Back', () => {
    // The composition menu comes first (four categories), then the oil steps.
    const menu = sessionAtOilCategory();
    expect(renderedButtons(menu)).toEqual([
      ...MOTOR_OIL_CATEGORY_IDS,
      '⬅️ Назад',
    ]);

    const s = sessionAtViscosity();
    expect(renderedButtons(s)).toEqual([
      ...OIL_VISCOSITIES,
      'Другое',
      '⬅️ Назад',
    ]);

    selectOilViscosity(s, FIVE_W_30);
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

  it('Back from "Что продаёте?" returns to the brand list', () => {
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
      WizardStep.OIL_VISCOSITY,
      WizardStep.OTHER_CATEGORY,
      WizardStep.OTHER_KIND,
      WizardStep.BRAND,
    ]);
  });

  it('the Back path through BOTH free-text branches is complete', () => {
    const s = sessionAtViscosity();
    selectOilViscosity(s, 'custom');
    inputOilViscosity(s, '0W-16');
    selectOilVolume(s, 'custom');
    inputOilVolume(s, '3,5');

    const visited: WizardStep[] = [s.step];
    while (goBack(s).status === 'ok') visited.push(s.step);
    expect(visited).toEqual([
      WizardStep.TITLE,
      WizardStep.OIL_VOLUME_CUSTOM,
      WizardStep.OIL_VOLUME,
      WizardStep.OIL_VISCOSITY_CUSTOM,
      WizardStep.OIL_VISCOSITY,
      WizardStep.OTHER_CATEGORY,
      WizardStep.OTHER_KIND,
      WizardStep.BRAND,
    ]);
  });

  it('OTHER_CATEGORY never appears in the spare-parts flow', () => {
    // It is a shared-prefix step gated on the branch actually being taken, so a
    // spare-part seller must never walk back into the "Другое" menu.
    const s = freshSession();
    selectBrand(s, 0);
    selectModel(s, 0);
    s.categoryOptions = [{ id: 'brake-system', name: 'Тормозная система' }];
    selectCategory(s, 'brake-system', [{ id: 'brakes', name: 'Тормоза' }]);
    selectSubcategory(s, 'brakes', []);
    inputTitle(s, 'Фильтр масляный');
    inputDescription(s, 'Новый');
    choosePartNumberType(s, 'OEM');
    inputPartNumber(s, '96535062');

    const visited: WizardStep[] = [s.step];
    while (goBack(s).status === 'ok') visited.push(s.step);
    expect(visited).not.toContain(WizardStep.OTHER_CATEGORY);
    expect(visited).not.toContain(WizardStep.OTHER_KIND);
    expect(visited[visited.length - 1]).toBe(WizardStep.BRAND);
  });
});

describe('callback payloads stay within Telegram limits', () => {
  it('every rendered payload is unique per step and under 64 bytes', () => {
    const s = sessionAtViscosity();
    const steps = [
      WizardStep.OTHER_KIND,
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

/**
 * The questionnaire a session walks must follow the CHOSEN CATEGORY, not the
 * high-water mark of everything the seller ever tapped.
 *
 * The regression: `selectCategory` only ever UPGRADED the kind (it acted when a
 * category declared one and ignored it otherwise), so the switch was one-way. A
 * seller who opened "Моторные масла", walked back, and picked an ordinary
 * category kept kind=MOTOR_OIL — and the flow asked for oil viscosity for a
 * brake pad. A category that declares no kind now IS the SPARE_PART answer.
 */
describe('the chosen category determines the flow (no sticky MOTOR_OIL)', () => {
  /** The root grid the bot renders after a car is chosen. */
  const ROOTS = [
    { id: 'brake-system', name: 'Тормозная система' },
    { id: 'engine-system', name: 'Двигатель' },
    { id: 'motor-oil', name: 'Моторные масла', kind: ProductKind.MOTOR_OIL },
  ];

  /** A session standing on the CATEGORY step with the root grid rendered. */
  function atCategory(): WizardSession {
    const s = freshSession();
    selectBrand(s, 0);
    selectModel(s, 0);
    s.categoryOptions = ROOTS;
    return s;
  }

  it.each([['brake-system'], ['engine-system']])(
    'SPARE_PART + ordinary category "%s" never reaches OIL_VISCOSITY',
    (categoryId) => {
      const s = atCategory();
      selectCategory(s, categoryId, []);
      expect(s.kind).toBe(ProductKind.SPARE_PART);
      expect(s.step).toBe(WizardStep.TITLE);
    },
  );

  it('an ordinary category with children asks the subcategory, then TITLE', () => {
    const s = atCategory();
    selectCategory(s, 'brake-system', [{ id: 'brakes', name: 'Тормоза' }]);
    expect(s.step).toBe(WizardStep.SUBCATEGORY);
    selectSubcategory(s, 'brakes', []);
    expect(s.kind).toBe(ProductKind.SPARE_PART);
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('THE BUG: oil → back → ordinary category returns to the parts flow', () => {
    const s = atCategory();
    // `motor-oil` has children (the four compositions), so the pick opens that
    // level rather than starting the questionnaire outright.
    selectCategory(s, 'motor-oil', OIL_CATEGORY_OPTIONS);
    expect(s.step).toBe(WizardStep.SUBCATEGORY);

    goBack(s);
    expect(s.step).toBe(WizardStep.CATEGORY);

    s.categoryOptions = ROOTS;
    selectCategory(s, 'brake-system', []);
    expect(s.kind).toBe(ProductKind.SPARE_PART);
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('abandoning the oil branch drops the oil answers it collected', () => {
    const s = atCategory();
    selectCategory(s, 'motor-oil', []);
    selectOilType(s, SYNTHETIC);
    selectOilViscosity(s, FIVE_W_30);
    expect(s.oilViscosity).toBe('5W-30');

    while (s.step !== WizardStep.CATEGORY && goBack(s).status === 'ok') {
      // walk back to the category question
    }
    s.categoryOptions = ROOTS;
    selectCategory(s, 'brake-system', []);

    // A brake pad must carry no oil attributes into its draft.
    expect(s.kind).toBe(ProductKind.SPARE_PART);
    expect(s.oilViscosity).toBeNull();
    expect(s.oilType).toBeNull();
    expect(s.oilVolumeMl).toBeNull();
  });

  it('returning to the BRAND step also clears the abandoned oil answers', () => {
    const s = sessionAtViscosity();
    selectOilViscosity(s, FIVE_W_30);
    expect(s.oilType).toBe(OilType.SYNTHETIC);
    while (s.step !== WizardStep.BRAND && goBack(s).status === 'ok') {
      // walk back to the branch point
    }
    selectBrand(s, 0);
    expect(s.kind).toBe(ProductKind.SPARE_PART);
    expect(s.oilViscosity).toBeNull();
    expect(s.viscosityIsCustom).toBe(false);
  });

  it('the oil category opens the four compositions (vehicle path)', () => {
    const s = atCategory();
    selectCategory(s, 'motor-oil', OIL_CATEGORY_OPTIONS);
    expect(s.kind).toBe(ProductKind.MOTOR_OIL);
    // The compositions are the next question, and they are CATEGORIES.
    expect(s.step).toBe(WizardStep.SUBCATEGORY);
    expect(renderedButtons(s)).toEqual([
      ...MOTOR_OIL_CATEGORY_IDS,
      '⬅️ Назад',
    ]);
    // Picked AFTER a car, so the vehicle is kept and the listing is specific.
    expect(s.brand).toBe('Chevrolet');
    expect(s.model).toBe('Cobalt');

    // Picking one derives the type and moves on to the viscosity.
    selectSubcategory(s, CategoryAnchor.MINERAL_MOTOR_OIL, []);
    expect(s.oilType).toBe(OilType.MINERAL);
    expect(s.step).toBe(WizardStep.OIL_VISCOSITY);
  });

  it('"Другое" → a composition still starts the oil questionnaire', () => {
    const s = sessionAtViscosity();
    expect(s.kind).toBe(ProductKind.MOTOR_OIL);
    expect(s.step).toBe(WizardStep.OIL_VISCOSITY);
  });

  it('BOTH paths open the SAME four categories', () => {
    // The bug this replaces: the vehicle path and "Другое" read different
    // subtrees, so one showed viscosities and the other showed nothing.
    const vehicle = atCategory();
    selectCategory(vehicle, 'motor-oil', OIL_CATEGORY_OPTIONS);

    const other = sessionAtOilCategory();

    expect(renderedButtons(vehicle)).toEqual(renderedButtons(other));
    expect(renderedButtons(vehicle)).toEqual([
      ...MOTOR_OIL_CATEGORY_IDS,
      '⬅️ Назад',
    ]);
  });
});
