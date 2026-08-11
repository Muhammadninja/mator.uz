// Tests for the SALE-FORM step of the product wizard ("Как продаётся товар?" —
// Штука / Комплект / набор), which exists only for a category configured with
// BOTH Tasnif package codes.
//
// What is pinned here: the question appears exactly when the chosen category
// offers a choice and never otherwise; each answer stores the matching form;
// changing category drops a previous answer and recomputes the options; and a
// resumed draft keeps the form it already had. Pure FSM logic — no Telegraf, no
// I/O; the category's package codes are handed in by the caller exactly as the
// bot hands them in from the live tree.

import { PackageForm, ProductKind } from '@prisma/client';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  beginQuestionnaire,
  selectBrand,
  selectModel,
  selectCategory,
  selectSubcategory,
  selectOtherBrand,
  selectOtherCategory,
  selectPackageForm,
  inputTitle,
  goBack,
  previousStep,
  stepPrompt,
  packageFormKeyboard,
  PACKAGE_FORM_LABELS,
  WIZ_PACKAGE_FORM_ACTION,
  buildAction,
} from './product-wizard';
import { buildSessionFromDraft } from './telegram.service';
import { WIZARD_BRANDS } from './wizard-catalog';

/** Brakes, as supplied: sold as a single item AND as a set. */
const BOTH_CODES = { packageCodeSingle: '1417722', packageCodeSet: '1417723' };
/** Filters, as supplied: one form only. */
const SINGLE_CODE = { packageCodeSingle: '1499205', packageCodeSet: null };
/** A category an admin has not configured yet. */
const NO_CODES = { packageCodeSingle: null, packageCodeSet: null };

const BRAKE_SYSTEM = { id: 'brake-system', name: 'Тормозная система' };
const BRAKES = { id: 'brakes', name: 'Тормоза' };
const FILTERS = { id: 'filters', name: 'Фильтры' };

/** A session sitting on the CATEGORY step with the root options rendered. */
function sessionAtCategory(): WizardSession {
  const s = new WizardSessionStore().start(1);
  beginQuestionnaire(s);
  selectBrand(s, 0);
  selectModel(s, 0);
  s.categoryOptions = [BRAKE_SYSTEM, FILTERS];
  return s;
}

/** Pick a LEAF root category (no children) carrying `fiscal`. */
function pickLeafCategory(
  fiscal: { packageCodeSingle: string | null; packageCodeSet: string | null },
  option = BRAKE_SYSTEM,
): WizardSession {
  const s = sessionAtCategory();
  selectCategory(s, option.id, [], fiscal);
  return s;
}

describe('when the sale-form question is asked', () => {
  it('does NOT ask when the category has a single package code', () => {
    const s = pickLeafCategory(SINGLE_CODE, FILTERS);
    expect(s.step).toBe(WizardStep.TITLE);
    expect(s.packageChoiceRequired).toBe(false);
    // Nothing is stored: the category's only code applies at fiscalization.
    expect(s.packageForm).toBeNull();
  });

  it('does NOT ask when the category is not fiscally configured at all', () => {
    const s = pickLeafCategory(NO_CODES, FILTERS);
    expect(s.step).toBe(WizardStep.TITLE);
    expect(s.packageForm).toBeNull();
  });

  it('ASKS when the category carries both package codes', () => {
    const s = pickLeafCategory(BOTH_CODES);
    expect(s.step).toBe(WizardStep.PACKAGE_FORM);
    expect(s.packageChoiceRequired).toBe(true);
  });

  it('asks after the SUBCATEGORY step, from the leaf’s own codes', () => {
    const s = sessionAtCategory();
    // The root has children, so the root's own codes are not the answer.
    selectCategory(s, BRAKE_SYSTEM.id, [BRAKES], BOTH_CODES);
    expect(s.step).toBe(WizardStep.SUBCATEGORY);
    expect(s.packageChoiceRequired).toBe(false);

    selectSubcategory(s, BRAKES.id, [], BOTH_CODES);
    expect(s.step).toBe(WizardStep.PACKAGE_FORM);
  });

  it('asks on the "Другое" branch too, from the chosen child’s codes', () => {
    const s = new WizardSessionStore().start(1);
    beginQuestionnaire(s);
    selectOtherBrand(s);
    s.categoryOptions = [{ id: 'motorcycle-oil', name: 'Мотоциклетные масла' }];
    selectOtherCategory(s, 'motorcycle-oil', BOTH_CODES);

    expect(s.kind).toBe(ProductKind.MOTOR_OIL);
    expect(s.step).toBe(WizardStep.PACKAGE_FORM);
  });

  it('leaves the "Другое" branch untouched when its child has one code', () => {
    const s = new WizardSessionStore().start(1);
    beginQuestionnaire(s);
    selectOtherBrand(s);
    s.categoryOptions = [{ id: 'motorcycle-oil', name: 'Мотоциклетные масла' }];
    selectOtherCategory(s, 'motorcycle-oil', SINGLE_CODE);

    // Straight into the oil questionnaire, exactly as before this step existed.
    expect(s.step).toBe(WizardStep.OIL_VISCOSITY);
  });
});

describe('answering the question', () => {
  it('"Штука" stores the SINGLE form', () => {
    const s = pickLeafCategory(BOTH_CODES);
    expect(selectPackageForm(s, PackageForm.SINGLE).status).toBe('ok');
    expect(s.packageForm).toBe(PackageForm.SINGLE);
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('"Комплект / набор" stores the SET form', () => {
    const s = pickLeafCategory(BOTH_CODES);
    expect(selectPackageForm(s, PackageForm.SET).status).toBe('ok');
    expect(s.packageForm).toBe(PackageForm.SET);
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('ignores the answer on any other step (stale tap)', () => {
    const s = pickLeafCategory(SINGLE_CODE, FILTERS); // sits on TITLE
    expect(selectPackageForm(s, PackageForm.SET).status).toBe('stale');
    expect(s.packageForm).toBeNull();
  });

  it('renders both labelled buttons plus Back', () => {
    const s = pickLeafCategory(BOTH_CODES);
    const prompt = stepPrompt(s);
    expect(prompt.text).toBe('📦 Как продаётся товар?');

    const rows = packageFormKeyboard(s).reply_markup.inline_keyboard;
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ['Штука'],
      ['Комплект / набор'],
      ['⬅️ Назад'],
    ]);
    expect(PACKAGE_FORM_LABELS.SINGLE).toBe('Штука');
    expect(PACKAGE_FORM_LABELS.SET).toBe('Комплект / набор');
  });

  it('carries payloads the handler’s matcher accepts', () => {
    expect(WIZ_PACKAGE_FORM_ACTION.test(buildAction('pf', 'single'))).toBe(
      true,
    );
    expect(WIZ_PACKAGE_FORM_ACTION.test(buildAction('pf', 'set'))).toBe(true);
    expect(WIZ_PACKAGE_FORM_ACTION.test(buildAction('pf', 'both'))).toBe(false);
  });
});

describe('changing the category', () => {
  it('clears a previous answer and stops asking when the new category has one code', () => {
    const s = pickLeafCategory(BOTH_CODES);
    selectPackageForm(s, PackageForm.SET);
    expect(s.packageForm).toBe(PackageForm.SET);

    // Walk back to the category question and pick a single-form category.
    goBack(s); // → PACKAGE_FORM
    goBack(s); // → CATEGORY
    expect(s.step).toBe(WizardStep.CATEGORY);
    s.categoryOptions = [BRAKE_SYSTEM, FILTERS];
    selectCategory(s, FILTERS.id, [], SINGLE_CODE);

    expect(s.packageForm).toBeNull();
    expect(s.packageChoiceRequired).toBe(false);
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('re-asks (dropping the old answer) when the new category also offers a choice', () => {
    const s = pickLeafCategory(BOTH_CODES);
    selectPackageForm(s, PackageForm.SET);
    goBack(s);
    goBack(s);
    s.categoryOptions = [BRAKE_SYSTEM, FILTERS];
    selectCategory(s, FILTERS.id, [], {
      packageCodeSingle: '1417580',
      packageCodeSet: '1417581',
    });

    expect(s.packageForm).toBeNull();
    expect(s.step).toBe(WizardStep.PACKAGE_FORM);
  });

  it('drops the answer when a deeper pick moves the listing to another leaf', () => {
    const s = sessionAtCategory();
    selectCategory(s, BRAKE_SYSTEM.id, [BRAKES, FILTERS], BOTH_CODES);
    selectSubcategory(s, BRAKES.id, [], BOTH_CODES);
    selectPackageForm(s, PackageForm.SET);

    // Back through the sale-form question to the subcategory one, then pick a
    // leaf with a single code.
    goBack(s); // TITLE → PACKAGE_FORM
    goBack(s); // PACKAGE_FORM → SUBCATEGORY
    expect(s.step).toBe(WizardStep.SUBCATEGORY);
    s.categoryOptions = [BRAKES, FILTERS];
    selectSubcategory(s, FILTERS.id, [], SINGLE_CODE);

    expect(s.packageForm).toBeNull();
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('drops the answer when the seller leaves the parts flow via "Другое"', () => {
    const s = pickLeafCategory(BOTH_CODES);
    selectPackageForm(s, PackageForm.SINGLE);
    // Walk back to BRAND and take the "Другое" branch.
    while (s.step !== WizardStep.BRAND) goBack(s);
    selectOtherBrand(s);

    expect(s.packageForm).toBeNull();
    expect(s.packageChoiceRequired).toBe(false);
  });
});

describe('back-navigation', () => {
  it('sits between the category questions and TITLE', () => {
    const s = pickLeafCategory(BOTH_CODES);
    selectPackageForm(s, PackageForm.SET);
    expect(s.step).toBe(WizardStep.TITLE);
    expect(previousStep(s)).toBe(WizardStep.PACKAGE_FORM);

    goBack(s);
    expect(previousStep(s)).toBe(WizardStep.CATEGORY);
  });

  it('is absent from the path when the category never raised it', () => {
    const s = pickLeafCategory(SINGLE_CODE, FILTERS);
    expect(previousStep(s)).toBe(WizardStep.CATEGORY);
  });

  it('keeps the answer when walking back and forward again', () => {
    const s = pickLeafCategory(BOTH_CODES);
    selectPackageForm(s, PackageForm.SET);
    goBack(s);
    expect(s.step).toBe(WizardStep.PACKAGE_FORM);
    // Untouched by the move — only re-answering overwrites it.
    expect(s.packageForm).toBe(PackageForm.SET);
    selectPackageForm(s, PackageForm.SET);
    inputTitle(s, 'Колодки тормозные');
    expect(s.packageForm).toBe(PackageForm.SET);
  });
});

describe('resuming a draft', () => {
  /** A draft as Prisma returns it (only the fields the rebuild reads). */
  const draft = (over: Record<string, unknown> = {}) => ({
    id: 'draft_1',
    kind: ProductKind.SPARE_PART,
    brand: WIZARD_BRANDS[0].name,
    model: WIZARD_BRANDS[0].models[0],
    category: null,
    subcategory: null,
    vehicleCategoryId: 'brake-system',
    categoryId: 'brakes',
    packageForm: null,
    title: null,
    description: null,
    partNumberType: 'UNKNOWN',
    partNumber: null,
    oilViscosity: null,
    oilType: null,
    oilVolumeMl: null,
    priceUzs: null,
    ...over,
  });

  it('preserves an already-answered sale form', () => {
    const s = buildSessionFromDraft(
      draft({ packageForm: PackageForm.SET }) as never,
      WizardStep.TITLE,
    );
    expect(s.packageForm).toBe(PackageForm.SET);
    // …and the step stays on the path, so "⬅️ Назад" returns to it.
    expect(s.packageChoiceRequired).toBe(true);
    expect(previousStep(s)).toBe(WizardStep.PACKAGE_FORM);
  });

  it('keeps the question on the path for a draft resumed ON it', () => {
    const s = buildSessionFromDraft(draft() as never, WizardStep.PACKAGE_FORM);
    expect(s.step).toBe(WizardStep.PACKAGE_FORM);
    expect(s.packageChoiceRequired).toBe(true);
    // Answering advances into the shared tail rather than ending the flow.
    selectPackageForm(s, PackageForm.SINGLE);
    expect(s.step).toBe(WizardStep.TITLE);
  });

  it('does not invent the question for a draft that was never asked', () => {
    const s = buildSessionFromDraft(draft() as never, WizardStep.TITLE);
    expect(s.packageForm).toBeNull();
    expect(s.packageChoiceRequired).toBe(false);
    // Straight back to the category questions — this draft chose a
    // subcategory (categoryId ≠ vehicleCategoryId), so that is the step before
    // TITLE, with no sale-form question spliced in between.
    expect(previousStep(s)).toBe(WizardStep.SUBCATEGORY);
  });
});
