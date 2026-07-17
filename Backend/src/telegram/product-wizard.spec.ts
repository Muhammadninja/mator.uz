// Tests for the product-creation wizard FSM: step ordering, button-only brand /
// model / category selection, text-input validation, the optional description
// and part-number branches, and stale-event protection. Pure logic — no
// Telegraf, no I/O.

import { PartVehicleCategory } from '@prisma/client';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  selectBrand,
  selectModel,
  selectCategory,
  inputTitle,
  inputDescription,
  skipDescription,
  choosePartNumberType,
  inputPartNumber,
  inputPrice,
  beginProcessing,
  backToPhotos,
  stepPrompt,
  brandKeyboard,
  modelKeyboard,
  categoryKeyboard,
  buildAction,
  CATALOG_VERSION,
  WIZ_BRAND_ACTION,
  WIZ_MODEL_ACTION,
  WIZ_CATEGORY_ACTION,
  WIZ_PART_NUMBER_TYPE_ACTION,
  WIZ_ANY_ACTION,
  isStaleCatalogPayload,
} from './product-wizard';
import { WIZARD_BRANDS, WIZARD_CATEGORIES } from './wizard-catalog';

const CHEVROLET = 0; // index in WIZARD_BRANDS
const COBALT = 0; // index in Chevrolet's model list

function freshSession(): WizardSession {
  return new WizardSessionStore().start(1);
}

/** Drive a session through the button steps up to TITLE. */
function sessionAtTitle(): WizardSession {
  const s = freshSession();
  selectBrand(s, CHEVROLET);
  selectModel(s, COBALT);
  selectCategory(s, 0); // Тормозная система
  return s;
}

/** Drive a session through every step up to PHOTOS (happy path with OEM). */
function sessionAtPhotos(): WizardSession {
  const s = sessionAtTitle();
  inputTitle(s, 'Передний амортизатор');
  inputDescription(s, 'Новый, оригинал');
  choosePartNumberType(s, 'OEM');
  inputPartNumber(s, '96535062');
  inputPrice(s, '250 000');
  return s;
}

describe('WizardSessionStore', () => {
  it('start() creates a fresh session at the BRAND step', () => {
    const store = new WizardSessionStore();
    const s = store.start(42);
    expect(s.step).toBe(WizardStep.BRAND);
    expect(s.brand).toBeNull();
    expect(s.partNumberType).toBe('UNKNOWN');
    expect(store.get(42)).toBe(s);
  });

  it('start() replaces an in-progress session (wizard restart)', () => {
    const store = new WizardSessionStore();
    const first = store.start(42);
    selectBrand(first, CHEVROLET);
    const second = store.start(42);
    expect(store.get(42)).toBe(second);
    expect(second.step).toBe(WizardStep.BRAND);
  });

  it('deleteIf() removes only the expected session instance', () => {
    const store = new WizardSessionStore();
    const first = store.start(42);
    const second = store.start(42); // user restarted while first was processing
    store.deleteIf(42, first); // old flow finishing must NOT kill the new session
    expect(store.get(42)).toBe(second);
    store.deleteIf(42, second);
    expect(store.get(42)).toBeUndefined();
  });
});

describe('wizard happy path', () => {
  it('walks BRAND → … → PHOTOS collecting every field', () => {
    const s = sessionAtPhotos();
    expect(s).toMatchObject({
      step: WizardStep.PHOTOS,
      brand: 'Chevrolet',
      model: 'Cobalt',
      category: PartVehicleCategory.BRAKE_SYSTEM,
      title: 'Передний амортизатор',
      description: 'Новый, оригинал',
      partNumberType: 'OEM',
      partNumber: '96535062',
      price: 250000,
    });
  });

  it('PHOTOS → PROCESSING → (failure) → PHOTOS', () => {
    const s = sessionAtPhotos();
    expect(beginProcessing(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.PROCESSING);
    // A second album may not race the first.
    expect(beginProcessing(s).status).toBe('stale');
    expect(backToPhotos(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.PHOTOS);
  });
});

describe('brand / model / category selection (buttons only)', () => {
  it("selecting a brand shows only that brand's models", () => {
    const s = freshSession();
    expect(selectBrand(s, CHEVROLET).status).toBe('ok');
    expect(s.brand).toBe('Chevrolet');
    const kb = modelKeyboard('Chevrolet').reply_markup.inline_keyboard.flat();
    expect(kb.map((b) => b.text)).toEqual(WIZARD_BRANDS[CHEVROLET].models);
  });

  it('model index resolves against the SELECTED brand', () => {
    const s = freshSession();
    selectBrand(s, 2); // Ravon
    expect(selectModel(s, 0).status).toBe('ok');
    expect(s.model).toBe('R2 (Spark)');
  });

  it('rejects out-of-range brand/model/category indexes as stale', () => {
    const s = freshSession();
    expect(selectBrand(s, 99).status).toBe('stale');
    selectBrand(s, CHEVROLET);
    expect(selectModel(s, 99).status).toBe('stale');
    selectModel(s, COBALT);
    expect(selectCategory(s, 99).status).toBe('stale');
  });

  it('ignores selections arriving at the wrong step (stale buttons)', () => {
    const s = freshSession();
    expect(selectModel(s, 0).status).toBe('stale'); // no brand chosen yet
    expect(selectCategory(s, 0).status).toBe('stale');
    selectBrand(s, CHEVROLET);
    expect(selectBrand(s, 1).status).toBe('stale'); // brand already chosen
    expect(s.brand).toBe('Chevrolet'); // unchanged
  });

  it('category buttons carry every wizard category', () => {
    const kb = categoryKeyboard().reply_markup.inline_keyboard.flat();
    expect(kb.map((b) => b.text)).toEqual(
      WIZARD_CATEGORIES.map((c) => c.label),
    );
    expect(brandKeyboard().reply_markup.inline_keyboard.flat()).toHaveLength(
      13,
    );
  });
});

describe('versioned callback payloads (invalidate stale buttons)', () => {
  // A callback_data helper for typing (Telegraf's button types are loose).
  const data = (b: unknown): string =>
    (b as { callback_data: string }).callback_data;

  it('every keyboard payload carries the current CATALOG_VERSION', () => {
    const prefix = `wiz:${CATALOG_VERSION}:`;
    const all = [
      ...brandKeyboard().reply_markup.inline_keyboard.flat(),
      ...modelKeyboard('Chevrolet').reply_markup.inline_keyboard.flat(),
      ...categoryKeyboard().reply_markup.inline_keyboard.flat(),
    ];
    for (const btn of all) expect(data(btn)).toMatch(new RegExp(`^${prefix}`));
  });

  it('current-version payloads match their action regex', () => {
    expect(WIZ_BRAND_ACTION.test(buildAction('b', 0))).toBe(true);
    expect(WIZ_MODEL_ACTION.test(buildAction('m', 3))).toBe(true);
    expect(WIZ_CATEGORY_ACTION.test(buildAction('c', 7))).toBe(true);
    expect(WIZ_PART_NUMBER_TYPE_ACTION.test(buildAction('t', 'OEM'))).toBe(
      true,
    );
  });

  it('a payload from a DIFFERENT catalog version no longer matches', () => {
    // Simulate a button minted before a catalog bump: same shape, older version.
    const stale = `wiz:${CATALOG_VERSION + 1}:b:0`;
    expect(WIZ_BRAND_ACTION.test(stale)).toBe(false);
    // ...and an unversioned legacy payload is also inert.
    expect(WIZ_BRAND_ACTION.test('wiz:b:0')).toBe(false);
  });

  it('WIZ_ANY_ACTION catches every wizard-shaped payload (any version)', () => {
    expect(WIZ_ANY_ACTION.test(buildAction('b', 0))).toBe(true); // current
    expect(WIZ_ANY_ACTION.test(`wiz:${CATALOG_VERSION + 9}:m:2`)).toBe(true);
    expect(WIZ_ANY_ACTION.test('wiz:b:0')).toBe(true); // legacy unversioned
    expect(WIZ_ANY_ACTION.test('product:add')).toBe(false); // not a wizard tap
  });

  it('isStaleCatalogPayload flags only OTHER versions (and malformed ones)', () => {
    expect(isStaleCatalogPayload(buildAction('b', 0))).toBe(false); // current → live
    expect(isStaleCatalogPayload(buildAction('t', 'OEM'))).toBe(false);
    expect(isStaleCatalogPayload(`wiz:${CATALOG_VERSION + 1}:b:0`)).toBe(true);
    expect(isStaleCatalogPayload('wiz:b:0')).toBe(true); // unversioned legacy
    expect(isStaleCatalogPayload('wiz:x:b:0')).toBe(true); // non-numeric version
  });
});

describe('title input', () => {
  it('accepts a valid title and collapses internal whitespace', () => {
    const s = sessionAtTitle();
    expect(inputTitle(s, '  Передний\n амортизатор  ').status).toBe('ok');
    expect(s.title).toBe('Передний амортизатор');
    expect(s.step).toBe(WizardStep.DESCRIPTION);
  });

  it.each([
    ['ab', 'короткое'],
    ['x'.repeat(256), 'длинное'],
    ['/help', 'команду'],
  ])('rejects %s and re-asks', (raw, fragment) => {
    const s = sessionAtTitle();
    const result = inputTitle(s, raw);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.message).toContain(fragment);
    expect(s.step).toBe(WizardStep.TITLE); // still waiting for a title
  });
});

describe('description step (optional)', () => {
  it('accepts text', () => {
    const s = sessionAtTitle();
    inputTitle(s, 'Фильтр масляный');
    expect(inputDescription(s, 'Оригинал, новый').status).toBe('ok');
    expect(s.description).toBe('Оригинал, новый');
    expect(s.step).toBe(WizardStep.PART_NUMBER_TYPE);
  });

  it('Skip stores null and advances', () => {
    const s = sessionAtTitle();
    inputTitle(s, 'Фильтр масляный');
    expect(skipDescription(s).status).toBe('ok');
    expect(s.description).toBeNull();
    expect(s.step).toBe(WizardStep.PART_NUMBER_TYPE);
  });
});

describe('part-number branch', () => {
  function atPartNumberType(): WizardSession {
    const s = sessionAtTitle();
    inputTitle(s, 'Фильтр масляный');
    skipDescription(s);
    return s;
  }

  it('OEM/GM ask for the number, then move to PRICE', () => {
    const s = atPartNumberType();
    expect(choosePartNumberType(s, 'GM').status).toBe('ok');
    expect(s.step).toBe(WizardStep.PART_NUMBER);
    expect(inputPartNumber(s, ' 96535062 ').status).toBe('ok');
    expect(s).toMatchObject({
      partNumberType: 'GM',
      partNumber: '96535062',
      step: WizardStep.PRICE,
    });
  });

  it('Skip jumps straight to PRICE with no number and UNKNOWN type', () => {
    const s = atPartNumberType();
    expect(choosePartNumberType(s, 'SKIP').status).toBe('ok');
    expect(s).toMatchObject({
      partNumberType: 'UNKNOWN',
      partNumber: null,
      step: WizardStep.PRICE,
    });
  });

  it.each([
    ['58101-2VA00', '58101-2VA00'], // hyphen + letters
    ['96 953 062', '96 953 062'], // spaces allowed (real GM grouping)
    ['13 51  7 508 003', '13 51 7 508 003'], // multi-space collapsed
    ['GM96440756', 'GM96440756'], // letters + digits
    ['1K0 615 301 M', '1K0 615 301 M'], // VW-style with trailing letter
    ['a.b/c-1', 'a.b/c-1'], // dot & slash separators
  ])('accepts common OEM/GM format %s', (raw, stored) => {
    const s = atPartNumberType();
    choosePartNumberType(s, 'OEM');
    expect(inputPartNumber(s, raw).status).toBe('ok');
    expect(s.partNumber).toBe(stored);
    expect(s.step).toBe(WizardStep.PRICE);
  });

  it.each([
    '12', // too short
    'no-digits-here', // no digit
    '£$%123', // illegal chars
    '-123', // must start alphanumeric
    '123-', // must end alphanumeric
    'x'.repeat(51), // over the 50-char DB cap
  ])('rejects invalid number %s', (raw) => {
    const s = atPartNumberType();
    choosePartNumberType(s, 'OEM');
    expect(inputPartNumber(s, raw).status).toBe('invalid');
    expect(s.step).toBe(WizardStep.PART_NUMBER);
  });
});

describe('price input (shared parsePrice rules)', () => {
  function atPrice(): WizardSession {
    const s = sessionAtTitle();
    inputTitle(s, 'Фильтр масляный');
    skipDescription(s);
    choosePartNumberType(s, 'SKIP');
    return s;
  }

  it.each([
    ['250 000', 250000],
    ['130.000 сум', 130000],
    ['1.250.000', 1250000],
    ['350000', 350000],
  ])('parses %s → %i and advances to PHOTOS', (raw, expected) => {
    const s = atPrice();
    expect(inputPrice(s, raw).status).toBe('ok');
    expect(s.price).toBe(expected);
    expect(s.step).toBe(WizardStep.PHOTOS);
  });

  it.each([['нет цены'], ['0'], ['-500'], ['9999999999999999']])(
    'rejects %s and re-asks',
    (raw) => {
      const s = atPrice();
      expect(inputPrice(s, raw).status).toBe('invalid');
      expect(s.step).toBe(WizardStep.PRICE);
    },
  );
});

describe('stepPrompt', () => {
  it('button steps carry a keyboard, text steps do not', () => {
    const s = freshSession();
    expect(stepPrompt(s).keyboard).toBeDefined(); // BRAND
    selectBrand(s, CHEVROLET);
    expect(stepPrompt(s).keyboard).toBeDefined(); // MODEL
    expect(stepPrompt(s).text).toContain('Chevrolet');
    selectModel(s, COBALT);
    expect(stepPrompt(s).keyboard).toBeDefined(); // CATEGORY
    selectCategory(s, 0);
    expect(stepPrompt(s).keyboard).toBeUndefined(); // TITLE
    inputTitle(s, 'Фильтр масляный');
    expect(stepPrompt(s).keyboard).toBeDefined(); // DESCRIPTION (Skip)
    skipDescription(s);
    expect(stepPrompt(s).keyboard).toBeDefined(); // PART_NUMBER_TYPE
    choosePartNumberType(s, 'OEM');
    expect(stepPrompt(s).keyboard).toBeUndefined(); // PART_NUMBER
    expect(stepPrompt(s).text).toContain('OEM');
    inputPartNumber(s, '96535062');
    expect(stepPrompt(s).keyboard).toBeUndefined(); // PRICE
    inputPrice(s, '250 000');
    expect(stepPrompt(s).keyboard).toBeUndefined(); // PHOTOS
    expect(stepPrompt(s).text).toContain('фото');
  });
});
