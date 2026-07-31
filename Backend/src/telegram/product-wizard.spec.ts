// Tests for the photos-first product-creation wizard FSM: step ordering,
// button-only brand / model / category selection, text-input validation, the
// optional description and part-number branches, and stale-event protection.
// Pure logic — no Telegraf, no I/O.

import { PartMainCategory, PartVehicleCategory } from '@prisma/client';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  selectBrand,
  selectModel,
  selectCategory,
  selectSubcategory,
  inputTitle,
  inputDescription,
  skipDescription,
  choosePartNumberType,
  inputPartNumber,
  inputPrice,
  beginQuestionnaire,
  previousStep,
  goBack,
  stepPrompt,
  brandKeyboard,
  modelKeyboard,
  categoryKeyboard,
  subcategoryKeyboard,
  buildAction,
  CATALOG_VERSION,
  WIZ_BRAND_ACTION,
  WIZ_MODEL_ACTION,
  WIZ_CATEGORY_ACTION,
  WIZ_PART_NUMBER_TYPE_ACTION,
  WIZ_ANY_ACTION,
  isStaleCatalogPayload,
} from './product-wizard';
import type { CategoryOption } from './product-wizard';
import { WIZARD_BRANDS } from './wizard-catalog';

const CHEVROLET = 0; // index in WIZARD_BRANDS
const COBALT = 0; // index in Chevrolet's model list

/**
 * A stand-in for the category tree the bot loads from the backend. The wizard is
 * pure — the CALLER supplies each level's options — so the tests supply them
 * too. Mirrors the seeded tree (roots → main categories) closely enough to
 * exercise the real shapes, including the enum mirrors.
 */
const CATEGORY_ROOTS: CategoryOption[] = [
  {
    id: 'brake-system',
    name: 'Тормозная система',
    vehicleCategoryEnum: PartVehicleCategory.BRAKE_SYSTEM,
  },
  {
    id: 'engine-system',
    name: 'Двигатель',
    vehicleCategoryEnum: PartVehicleCategory.ENGINE,
  },
  {
    id: 'transmission',
    name: 'Трансмиссия',
    vehicleCategoryEnum: PartVehicleCategory.TRANSMISSION,
  },
  {
    id: 'heating-and-cooling',
    name: 'Климат и Охлаждение',
    vehicleCategoryEnum: PartVehicleCategory.HEATING_AND_COOLING,
  },
];

const CATEGORY_CHILDREN: Record<string, CategoryOption[]> = {
  'brake-system': [
    { id: 'brakes', name: 'Тормоза', mainCategoryEnum: PartMainCategory.BRAKES },
  ],
  'engine-system': [
    { id: 'engine', name: 'Двигатель', mainCategoryEnum: PartMainCategory.ENGINE },
    {
      id: 'belts-and-hoses',
      name: 'Ремни и патрубки',
      mainCategoryEnum: PartMainCategory.BELTS_AND_HOSES,
    },
  ],
  // transmission / heating-and-cooling deliberately absent → leaf categories.
};

/** The active children of a category, as the bot would have loaded them. */
const childrenOf = (id: string): CategoryOption[] => CATEGORY_CHILDREN[id] ?? [];

/** Put a session on the CATEGORY step with the root options rendered. */
function withRootOptions(s: WizardSession): WizardSession {
  s.categoryOptions = CATEGORY_ROOTS;
  return s;
}

/** A session that has passed PHOTOS_FIRST and sits at the first question (BRAND). */
function freshSession(): WizardSession {
  const s = new WizardSessionStore().start(1);
  beginQuestionnaire(s); // photos accepted → BRAND
  return s;
}

/** Drive a session through the button steps up to TITLE. */
function sessionAtTitle(): WizardSession {
  const s = freshSession();
  selectBrand(s, CHEVROLET);
  selectModel(s, COBALT);
  withRootOptions(s);
  selectCategory(s, 'brake-system', childrenOf('brake-system')); // has children
  selectSubcategory(s, 'brakes', []); // Тормоза (a leaf) → flow resumes
  return s;
}

/** Drive a session through every question (happy path with OEM) → QUESTIONNAIRE_DONE. */
function sessionAtDone(): WizardSession {
  const s = sessionAtTitle();
  inputTitle(s, 'Передний амортизатор');
  inputDescription(s, 'Новый, оригинал');
  choosePartNumberType(s, 'OEM');
  inputPartNumber(s, '96535062');
  inputPrice(s, '250 000');
  return s;
}

describe('WizardSessionStore', () => {
  it('start() creates a fresh session at the PHOTOS_FIRST step', () => {
    const store = new WizardSessionStore();
    const s = store.start(42);
    expect(s.step).toBe(WizardStep.PHOTOS_FIRST);
    expect(s.draftId).toBeNull();
    expect(s.brand).toBeNull();
    expect(s.partNumberType).toBe('UNKNOWN');
    expect(store.get(42)).toBe(s);
  });

  it('start() replaces an in-progress session (wizard restart)', () => {
    const store = new WizardSessionStore();
    const first = store.start(42);
    beginQuestionnaire(first);
    selectBrand(first, CHEVROLET);
    const second = store.start(42);
    expect(store.get(42)).toBe(second);
    expect(second.step).toBe(WizardStep.PHOTOS_FIRST);
  });

  it('restore() re-inserts a session rebuilt from a draft', () => {
    const store = new WizardSessionStore();
    const rebuilt: WizardSession = {
      ...store.start(42),
      step: WizardStep.PRICE,
      draftId: 'draft_1',
    };
    store.restore(42, rebuilt);
    expect(store.get(42)).toBe(rebuilt);
    expect(store.get(42)?.step).toBe(WizardStep.PRICE);
  });

  it('deleteIf() removes only the expected session instance', () => {
    const store = new WizardSessionStore();
    const first = store.start(42);
    const second = store.start(42); // user restarted while first was processing
    store.deleteIf(42, first); // the finishing draft must NOT kill the new session
    expect(store.get(42)).toBe(second);
    store.deleteIf(42, second);
    expect(store.get(42)).toBeUndefined();
  });
});

describe('wizard happy path', () => {
  it('walks PHOTOS_FIRST → BRAND → … → QUESTIONNAIRE_DONE collecting every field', () => {
    const s = sessionAtDone();
    expect(s).toMatchObject({
      step: WizardStep.QUESTIONNAIRE_DONE,
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
});

describe('brand / model / category selection (buttons only)', () => {
  it("selecting a brand shows only that brand's models", () => {
    const s = freshSession();
    expect(selectBrand(s, CHEVROLET).status).toBe('ok');
    expect(s.brand).toBe('Chevrolet');
    // Drop the trailing "⬅️ Назад" row before comparing model labels.
    const kb = modelKeyboard(
      s,
      'Chevrolet',
    ).reply_markup.inline_keyboard.flat();
    expect(kb.map((b) => b.text).filter((t) => t !== '⬅️ Назад')).toEqual(
      WIZARD_BRANDS[CHEVROLET].models,
    );
  });

  it('model index resolves against the SELECTED brand', () => {
    const s = freshSession();
    selectBrand(s, 2); // Ravon
    expect(selectModel(s, 0).status).toBe('ok');
    expect(s.model).toBe('R2 (Spark)');
  });

  it('rejects out-of-range brand/model indexes and unknown category ids as stale', () => {
    const s = freshSession();
    expect(selectBrand(s, 99).status).toBe('stale');
    selectBrand(s, CHEVROLET);
    expect(selectModel(s, 99).status).toBe('stale');
    selectModel(s, COBALT);
    withRootOptions(s);
    expect(selectCategory(s, 'no-such-category').status).toBe('stale');
  });

  it('ignores selections arriving at the wrong step (stale buttons)', () => {
    const s = freshSession();
    expect(selectModel(s, 0).status).toBe('stale'); // no brand chosen yet
    expect(selectCategory(s, 'brake-system').status).toBe('stale');
    selectBrand(s, CHEVROLET);
    expect(selectBrand(s, 1).status).toBe('stale'); // brand already chosen
    expect(s.brand).toBe('Chevrolet'); // unchanged
  });

  it('category buttons are built from the loaded options, carrying their ids', () => {
    const s = freshSession();
    selectBrand(s, CHEVROLET);
    selectModel(s, COBALT); // now at CATEGORY
    withRootOptions(s);
    const kb = categoryKeyboard(s).reply_markup.inline_keyboard.flat();
    expect(kb.map((b) => b.text).filter((t) => t !== '⬅️ Назад')).toEqual(
      CATEGORY_ROOTS.map((c) => c.name),
    );
    // Each payload carries the category ID, so an admin reordering the tree can
    // never make an in-flight button resolve to a different category.
    expect(
      kb
        .map((b) => (b as { callback_data: string }).callback_data)
        .filter((d) => d.includes(':c:')),
    ).toEqual(CATEGORY_ROOTS.map((c) => buildAction('c', c.id)));
    // BRAND is the first step → no "⬅️ Назад" button, so the keyboard is exactly
    // the brands plus the trailing "Другое" escape from the spare-parts flow.
    const brandButtons =
      brandKeyboard(freshSession()).reply_markup.inline_keyboard.flat();
    expect(brandButtons.map((b) => b.text)).toEqual([
      ...WIZARD_BRANDS.map((b) => b.name),
      'Другое',
    ]);
  });
});

describe('subcategory step (mandatory only where subcategories exist)', () => {
  /** A session sitting at CATEGORY, ready to pick one. */
  const atCategory = (): WizardSession => {
    const s = freshSession();
    selectBrand(s, CHEVROLET);
    selectModel(s, COBALT);
    // The caller (TelegramService) loads the roots before rendering the step.
    return withRootOptions(s);
  };

  it('a category WITH children asks for one before continuing', () => {
    const s = atCategory();
    selectCategory(s, 'brake-system', childrenOf('brake-system'));
    expect(s.step).toBe(WizardStep.SUBCATEGORY);
    expect(s.vehicleCategoryId).toBe('brake-system');
    // The root stands as the answer until a child narrows it.
    expect(s.categoryId).toBe('brake-system');

    expect(selectSubcategory(s, 'brakes', []).status).toBe('ok');
    expect(s.categoryId).toBe('brakes');
    expect(s.subcategory).toBe(PartMainCategory.BRAKES);
    expect(s.step).toBe(WizardStep.TITLE); // the existing flow resumes
  });

  // The empty-category rule: a category with NO active children must not show
  // an empty selection step — it continues straight to TITLE.
  it.each([['transmission'], ['heating-and-cooling']])(
    '%s has no children and goes straight to TITLE',
    (id) => {
      const s = atCategory();
      selectCategory(s, id, []); // no children loaded
      expect(s.step).toBe(WizardStep.TITLE);
      expect(s.categoryId).toBe(id); // the root itself is the answer
      // Back from TITLE returns to CATEGORY, not through a phantom step.
      expect(goBack(s).status).toBe('ok');
      expect(s.step).toBe(WizardStep.CATEGORY);
    },
  );

  it('builds subcategory buttons from the loaded children, not a hardcoded list', () => {
    const s = atCategory();
    selectCategory(s, 'engine-system', childrenOf('engine-system'));
    const labels = subcategoryKeyboard(s)
      .reply_markup.inline_keyboard.flat()
      .map((b) => b.text)
      .filter((t) => t !== '⬅️ Назад');
    expect(labels).toEqual(['Двигатель', 'Ремни и патрубки']);
  });

  it('an admin-created category with no enum mirror is still selectable', () => {
    // The whole point of the dynamic tree: a category the admin invented does
    // not exist in any enum, and must still flow through to the draft.
    const s = atCategory();
    selectCategory(s, 'brake-system', [
      { id: 'brake-pads-custom', name: 'Тормозные колодки' },
    ]);
    expect(selectSubcategory(s, 'brake-pads-custom', []).status).toBe('ok');
    expect(s.categoryId).toBe('brake-pads-custom');
    expect(s.subcategory).toBeNull(); // no enum mirror — expected
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('supports a third level when the admin nests deeper', () => {
    const s = atCategory();
    selectCategory(s, 'brake-system', childrenOf('brake-system'));
    // 'brakes' itself has children → the step repeats for the next level.
    expect(
      selectSubcategory(s, 'brakes', [
        { id: 'brake-pads', name: 'Тормозные колодки' },
        { id: 'brake-discs', name: 'Тормозные диски' },
      ]).status,
    ).toBe('ok');
    expect(s.step).toBe(WizardStep.SUBCATEGORY); // still choosing
    expect(selectSubcategory(s, 'brake-discs', []).status).toBe('ok');
    expect(s.categoryId).toBe('brake-discs');
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('re-picking a different category drops the earlier subcategory', () => {
    const s = atCategory();
    selectCategory(s, 'brake-system', childrenOf('brake-system'));
    selectSubcategory(s, 'brakes', []);
    expect(s.subcategory).toBe(PartMainCategory.BRAKES);

    // Walk back to the category question and choose one with a DIFFERENT list.
    goBack(s); // → SUBCATEGORY
    goBack(s); // → CATEGORY
    // Re-rendering the CATEGORY step reloads the roots (TelegramService does
    // this in ensureCategoryOptions before every category prompt).
    withRootOptions(s);
    selectCategory(s, 'engine-system', childrenOf('engine-system'));
    // The brakes answer must not survive into an engine listing.
    expect(s.subcategory).toBeNull();
    expect(s.step).toBe(WizardStep.SUBCATEGORY);
    selectSubcategory(s, 'belts-and-hoses', []);
    expect(s.subcategory).toBe(PartMainCategory.BELTS_AND_HOSES);
    expect(s.categoryId).toBe('belts-and-hoses');
  });

  it('rejects an unknown id and a pick at the wrong step as stale', () => {
    const s = atCategory();
    // Before the category is chosen there is no subcategory question at all.
    expect(selectSubcategory(s, 'brakes', []).status).toBe('stale');
    selectCategory(s, 'brake-system', childrenOf('brake-system'));
    // An id that is not in the CURRENT level's rendered options must not
    // resolve — this is what replaces the old out-of-range index guard, and it
    // is what stops a forged callback injecting an arbitrary category.
    expect(selectSubcategory(s, 'oil-filters', []).status).toBe('stale');
    expect(s.categoryId).toBe('brake-system'); // unchanged
    expect(s.step).toBe(WizardStep.SUBCATEGORY); // still waiting for an answer
  });

  // ── Legacy enum mirrors must never go stale ────────────────────────────────
  // A dynamic category with no enum equivalent must CLEAR any mirror a previous
  // selection left behind, or the draft would carry an enum taxonomy that
  // contradicts its categoryId.
  it('selecting a mirror-less sibling CLEARS a stale mainCategory', () => {
    const s = atCategory();
    selectCategory(s, 'brake-system', childrenOf('brake-system'));
    selectSubcategory(s, 'brakes', []); // → mainCategory mirror = BRAKES
    expect(s.subcategory).toBe(PartMainCategory.BRAKES);

    // Walk back and pick a sibling the admin created, which mirrors no enum.
    goBack(s); // → SUBCATEGORY
    s.categoryOptions = [
      { id: 'brakes', name: 'Тормоза', mainCategoryEnum: PartMainCategory.BRAKES },
      { id: 'brake-hardware', name: 'Тормозная фурнитура' },
    ];
    selectSubcategory(s, 'brake-hardware', []);

    expect(s.categoryId).toBe('brake-hardware');
    expect(s.subcategory).toBeNull(); // the BRAKES mirror must NOT survive
  });

  it('selecting a mirror-less ROOT clears a stale vehicleCategory', () => {
    const s = atCategory();
    selectCategory(s, 'brake-system', childrenOf('brake-system'));
    expect(s.category).toBe(PartVehicleCategory.BRAKE_SYSTEM);

    // selectCategory already advanced onto SUBCATEGORY, so ONE step back lands
    // on CATEGORY. Pick an admin-created root that mirrors no enum.
    goBack(s); // → CATEGORY
    s.categoryOptions = [{ id: 'body-and-interior', name: 'Кузов и салон' }];
    selectCategory(s, 'body-and-interior', []);

    expect(s.vehicleCategoryId).toBe('body-and-interior');
    expect(s.category).toBeNull(); // the BRAKE_SYSTEM mirror must NOT survive
    expect(s.subcategory).toBeNull();
  });

  it('re-picking a root clears BOTH mirrors before the new branch is walked', () => {
    const s = atCategory();
    selectCategory(s, 'brake-system', childrenOf('brake-system'));
    selectSubcategory(s, 'brakes', []);
    expect(s.subcategory).toBe(PartMainCategory.BRAKES);

    goBack(s);
    goBack(s);
    withRootOptions(s);
    // A root WITH children: the subcategory mirror must clear immediately, not
    // linger until the next level is answered.
    selectCategory(s, 'engine-system', childrenOf('engine-system'));
    expect(s.subcategory).toBeNull();
    expect(s.category).toBe(PartVehicleCategory.ENGINE);
  });

  it('rejects a forged ROOT category id that was never offered', () => {
    const s = atCategory();
    expect(selectCategory(s, 'not-a-category', []).status).toBe('stale');
    expect(s.vehicleCategoryId).toBeNull();
    expect(s.step).toBe(WizardStep.CATEGORY);
  });
});

describe('versioned callback payloads (invalidate stale buttons)', () => {
  // A callback_data helper for typing (Telegraf's button types are loose).
  const data = (b: unknown): string =>
    (b as { callback_data: string }).callback_data;

  it('every keyboard payload carries the current CATALOG_VERSION', () => {
    const prefix = `wiz:${CATALOG_VERSION}:`;
    // Use a session past the first step so the "⬅️ Назад" button is present too
    // — its payload is versioned like every other and must carry the prefix.
    const mid = freshSession();
    selectBrand(mid, CHEVROLET);
    const all = [
      ...brandKeyboard(freshSession()).reply_markup.inline_keyboard.flat(),
      ...modelKeyboard(mid, 'Chevrolet').reply_markup.inline_keyboard.flat(),
      ...categoryKeyboard(mid).reply_markup.inline_keyboard.flat(),
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
  ])('parses %s → %i and advances to QUESTIONNAIRE_DONE', (raw, expected) => {
    const s = atPrice();
    expect(inputPrice(s, raw).status).toBe('ok');
    expect(s.price).toBe(expected);
    expect(s.step).toBe(WizardStep.QUESTIONNAIRE_DONE);
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

describe('back navigation ("⬅️ Назад")', () => {
  it('BRAND (first step) has no previous step — goBack is stale', () => {
    const s = freshSession();
    expect(previousStep(s)).toBeNull();
    expect(goBack(s).status).toBe('stale');
    expect(s.step).toBe(WizardStep.BRAND);
  });

  it('walks back through the linear steps in reverse order', () => {
    const s = sessionAtTitle(); // at TITLE (BRAND→MODEL→CATEGORY→SUBCATEGORY done)
    inputTitle(s, 'Фильтр масляный'); // → DESCRIPTION
    inputDescription(s, 'Оригинал'); // → PART_NUMBER_TYPE

    expect(goBack(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.DESCRIPTION);
    expect(goBack(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.TITLE);
    expect(goBack(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.SUBCATEGORY);
    expect(goBack(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.CATEGORY);
    expect(goBack(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.MODEL);
    expect(goBack(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.BRAND);
    expect(goBack(s).status).toBe('stale'); // nowhere left to go
  });

  it('does NOT lose entered data when going back', () => {
    const s = sessionAtTitle();
    inputTitle(s, 'Передний амортизатор');
    inputDescription(s, 'Новый, оригинал'); // at PART_NUMBER_TYPE
    goBack(s); // → DESCRIPTION
    goBack(s); // → TITLE
    // Every earlier field survives the walk back.
    expect(s).toMatchObject({
      step: WizardStep.TITLE,
      brand: 'Chevrolet',
      model: 'Cobalt',
      category: PartVehicleCategory.BRAKE_SYSTEM,
      title: 'Передний амортизатор',
      description: 'Новый, оригинал',
    });
  });

  it('re-entering a value going forward overwrites the old one; others persist', () => {
    const s = sessionAtTitle();
    inputTitle(s, 'Старое название'); // → DESCRIPTION
    goBack(s); // → TITLE
    expect(inputTitle(s, 'Новое название').status).toBe('ok');
    expect(s.title).toBe('Новое название');
    expect(s.step).toBe(WizardStep.DESCRIPTION);
    // The brand/model/category chosen earlier are untouched.
    expect(s).toMatchObject({ brand: 'Chevrolet', model: 'Cobalt' });
  });

  it('PRICE → PART_NUMBER for an OEM/GM listing (number was asked)', () => {
    const s = sessionAtTitle();
    inputTitle(s, 'Фильтр');
    skipDescription(s);
    choosePartNumberType(s, 'GM');
    inputPartNumber(s, '96535062'); // at PRICE, partNumberType = GM
    expect(previousStep(s)).toBe(WizardStep.PART_NUMBER);
    goBack(s);
    expect(s.step).toBe(WizardStep.PART_NUMBER);
    expect(s.partNumber).toBe('96535062'); // preserved
  });

  it('PRICE → PART_NUMBER_TYPE when the number was skipped', () => {
    const s = sessionAtTitle();
    inputTitle(s, 'Фильтр');
    skipDescription(s);
    choosePartNumberType(s, 'SKIP'); // straight to PRICE, type UNKNOWN
    expect(previousStep(s)).toBe(WizardStep.PART_NUMBER_TYPE);
    goBack(s);
    expect(s.step).toBe(WizardStep.PART_NUMBER_TYPE);
  });

  it('QUESTIONNAIRE_DONE has no back (terminal — the coordinator owns the flow)', () => {
    const s = sessionAtDone();
    expect(previousStep(s)).toBeNull();
    expect(goBack(s).status).toBe('stale');
    expect(s.step).toBe(WizardStep.QUESTIONNAIRE_DONE);
  });
});

describe('stepPrompt', () => {
  // The label text of a step prompt's keyboard buttons (flattened rows).
  const labels = (s: WizardSession): string[] =>
    (stepPrompt(s).keyboard?.reply_markup.inline_keyboard.flat() ?? []).map(
      (b) => (b as { text: string }).text,
    );

  it('every step after the first carries a "⬅️ Назад" button', () => {
    const s = freshSession();
    // BRAND is the first step — a keyboard (brands), but NO Back button.
    expect(stepPrompt(s).keyboard).toBeDefined();
    expect(labels(s)).not.toContain('⬅️ Назад');

    selectBrand(s, CHEVROLET);
    expect(labels(s)).toContain('⬅️ Назад'); // MODEL
    expect(stepPrompt(s).text).toContain('Chevrolet');
    selectModel(s, COBALT);
    expect(labels(s)).toContain('⬅️ Назад'); // CATEGORY
    withRootOptions(s);
    selectCategory(s, 'brake-system', childrenOf('brake-system'));
    expect(labels(s)).toContain('⬅️ Назад'); // SUBCATEGORY
    selectSubcategory(s, 'brakes', []);
    expect(labels(s)).toContain('⬅️ Назад'); // TITLE (was keyboard-less before)
    inputTitle(s, 'Фильтр масляный');
    expect(labels(s)).toContain('⬅️ Назад'); // DESCRIPTION (Skip + Back)
    expect(labels(s)).toContain('⏭ Пропустить');
    skipDescription(s);
    expect(labels(s)).toContain('⬅️ Назад'); // PART_NUMBER_TYPE
    choosePartNumberType(s, 'OEM');
    expect(labels(s)).toContain('⬅️ Назад'); // PART_NUMBER
    expect(stepPrompt(s).text).toContain('OEM');
    inputPartNumber(s, '96535062');
    expect(labels(s)).toContain('⬅️ Назад'); // PRICE
    inputPrice(s, '250 000'); // → QUESTIONNAIRE_DONE (terminal, no keyboard)
    expect(stepPrompt(s).keyboard).toBeUndefined();
  });
});

describe('photos-first entry', () => {
  it('a new session starts at PHOTOS_FIRST with no draft yet', () => {
    const s = new WizardSessionStore().start(7);
    expect(s.step).toBe(WizardStep.PHOTOS_FIRST);
    expect(s.draftId).toBeNull();
  });

  it('beginQuestionnaire advances PHOTOS_FIRST → BRAND (and is stale elsewhere)', () => {
    const s = new WizardSessionStore().start(7);
    expect(beginQuestionnaire(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.BRAND);
    // A second call at BRAND is a stale no-op — a second album can't race the first.
    expect(beginQuestionnaire(s).status).toBe('stale');
    expect(s.step).toBe(WizardStep.BRAND);
  });

  it('PHOTOS_FIRST has no previous step (Back is stale)', () => {
    const s = new WizardSessionStore().start(7);
    expect(previousStep(s)).toBeNull();
    expect(goBack(s).status).toBe('stale');
  });

  it('BRAND has no previous step — photos precede it but are not a question', () => {
    const s = freshSession(); // at BRAND
    expect(previousStep(s)).toBeNull();
    expect(goBack(s).status).toBe('stale');
  });

  it('back-navigation walks the questionnaire and preserves data', () => {
    const s = freshSession();
    selectBrand(s, CHEVROLET);
    selectModel(s, COBALT);
    withRootOptions(s);
    selectCategory(s, 'brake-system', childrenOf('brake-system'));
    selectSubcategory(s, 'brakes', []);
    inputTitle(s, 'Амортизатор'); // → DESCRIPTION
    expect(goBack(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.TITLE);
    expect(goBack(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.SUBCATEGORY);
    expect(goBack(s).status).toBe('ok');
    expect(s.step).toBe(WizardStep.CATEGORY);
    // Data preserved.
    expect(s).toMatchObject({ brand: 'Chevrolet', model: 'Cobalt' });
  });

  it('stepPrompt: PHOTOS_FIRST asks for photos first; QUESTIONNAIRE_DONE shows the holding message', () => {
    const s = new WizardSessionStore().start(7);
    expect(stepPrompt(s).text).toContain('Сначала отправьте фотографии');
    s.step = WizardStep.QUESTIONNAIRE_DONE;
    expect(stepPrompt(s).text).toContain('Завершаем обработку');
  });

  it('the FSM has exactly the photos-first states (no legacy leftovers)', () => {
    expect(Object.keys(WizardStep).sort()).toEqual(
      [
        // Shared entry + branch point.
        'PHOTOS_FIRST',
        'BRAND',
        // Spare-parts branch.
        'MODEL',
        'CATEGORY',
        'SUBCATEGORY',
        'PART_NUMBER_TYPE',
        'PART_NUMBER',
        // "Другое" branch: the menu, then the motor-oil questionnaire.
        'OTHER_CATEGORY',
        'OIL_VISCOSITY',
        'OIL_VISCOSITY_CUSTOM',
        'OIL_TYPE',
        'OIL_VOLUME',
        'OIL_VOLUME_CUSTOM',
        // Shared tail.
        'TITLE',
        'DESCRIPTION',
        'PRICE',
        'QUESTIONNAIRE_DONE',
      ].sort(),
    );
  });
});
