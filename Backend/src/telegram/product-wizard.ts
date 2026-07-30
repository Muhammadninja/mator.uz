// src/telegram/product-wizard.ts
//
// Finite-state machine for the step-by-step, photos-FIRST product-creation wizard.
// Photos are ALWAYS first and always identical across kinds; after the BRAND step
// the dialogue BRANCHES on what the seller is listing:
//
//   PHOTOS_FIRST → BRAND ─┬─ (a car brand)  → MODEL → CATEGORY → TITLE
//                         │                    → DESCRIPTION → PART_NUMBER_TYPE
//                         │                    → [PART_NUMBER] → PRICE → DONE
//                         │
//                         └─ ("Другое")     → OTHER_CATEGORY ─ (Моторные масла)
//                                              → OIL_VISCOSITY → OIL_TYPE
//                                              → OIL_VOLUME → TITLE
//                                              → DESCRIPTION → PRICE → DONE
//
// Photos are processed in the BACKGROUND (BullMQ) while the seller answers the
// questionnaire; the preview appears when both tracks meet (see DraftCoordinator).
//
// ── How branching is modelled (and why there are no if/else chains) ──────────
// Each ProductKind owns a FLOW: an ORDERED LIST of the steps its questionnaire
// asks, declared once in FLOWS below. Everything that is "shaped like the flow"
// derives from that list instead of switching on the kind:
//   • forward motion  — each transition advances to `nextStep(session)`,
//   • "⬅️ Назад"      — `previousStep` is the list index minus one,
//   • step validity   — a step not in the session's flow is simply not reachable.
// Adding a kind (Антифриз, Аккумуляторы, …) therefore means: add its steps to
// WizardStep, add its prompt/keyboard cases, and add ONE FLOWS entry — no
// existing kind's code path is touched. Steps shared between kinds (TITLE,
// DESCRIPTION, PRICE) are written once and simply appear in several flows.
//
// This module is pure state + validation + prompt/keyboard builders (no Telegraf
// handlers, no I/O) so the whole FSM is unit-testable. A session holds only
// CONVERSATIONAL state — where the seller is in the dialogue and the id of the
// ProductDraft that owns the business data. It never holds uploaded assets: the
// draft (Postgres) is the single source of truth for those.

import {
  OilType,
  PartMainCategory,
  PartVehicleCategory,
  ProductKind,
} from '@prisma/client';
import { Markup } from 'telegraf';
import type { PartNumberType } from '../ai/part-parser.types';
import { parsePrice } from '../ai/price-parser';
import { capabilitiesOf, isUniversalKind } from '../common/product-kind';
import {
  OIL_TYPES,
  OIL_TYPE_LABELS,
  OIL_VISCOSITIES,
  OIL_VOLUMES,
  formatVolume,
  normalizeViscosity,
  parseVolumeLitres,
} from './motor-oil-catalog';
import {
  OTHER_BRAND_LABEL,
  WIZARD_BRANDS,
  WIZARD_CATEGORIES,
  WIZARD_OTHER_CATEGORIES,
  hasSubcategories,
  subcategoriesOf,
} from './wizard-catalog';

export enum WizardStep {
  /** Entry state: the very first thing the seller does is upload photos. Once they
   *  arrive, image processing is kicked off in the background (BullMQ) and the FSM
   *  jumps straight to BRAND so the questionnaire runs while the images process. */
  PHOTOS_FIRST = 'PHOTOS_FIRST',
  BRAND = 'BRAND',
  MODEL = 'MODEL',
  CATEGORY = 'CATEGORY',
  /** Narrow the chosen category down to one of its subcategories. Conditional:
   *  only reachable when the picked CATEGORY actually has subcategories (see
   *  `hasSubcategories`), so it is spliced into the flow by {@link flowSteps}
   *  rather than listed in FLOWS. */
  SUBCATEGORY = 'SUBCATEGORY',
  /** The "Другое" menu: pick a NON-spare-part category (Моторные масла, …). Only
   *  reachable from BRAND via the "Другое" button. */
  OTHER_CATEGORY = 'OTHER_CATEGORY',
  // ── Motor-oil steps ───────────────────────────────────────────────────────
  OIL_VISCOSITY = 'OIL_VISCOSITY',
  /** Free-text viscosity, reached only from OIL_VISCOSITY's "Другое" button. */
  OIL_VISCOSITY_CUSTOM = 'OIL_VISCOSITY_CUSTOM',
  OIL_TYPE = 'OIL_TYPE',
  OIL_VOLUME = 'OIL_VOLUME',
  /** Free-text volume, reached only from OIL_VOLUME's "Другое" button. */
  OIL_VOLUME_CUSTOM = 'OIL_VOLUME_CUSTOM',
  // ── Steps shared by every kind ────────────────────────────────────────────
  TITLE = 'TITLE',
  DESCRIPTION = 'DESCRIPTION',
  PART_NUMBER_TYPE = 'PART_NUMBER_TYPE',
  PART_NUMBER = 'PART_NUMBER',
  PRICE = 'PRICE',
  /** Questionnaire finished: every form field is collected. The wizard's work is
   *  done; the draft coordinator now owns the rendezvous with image processing and
   *  decides when to show the preview. Terminal for the FSM. */
  QUESTIONNAIRE_DONE = 'QUESTIONNAIRE_DONE',
}

/**
 * The ordered questionnaire of each kind — the ONE place a flow's shape is
 * declared. Steps that are conditional within a flow (PART_NUMBER, and the two
 * "Другое" free-text steps) are NOT listed: they are optional detours whose
 * inclusion depends on session state, resolved by {@link flowSteps}.
 *
 * PHOTOS_FIRST and BRAND precede every flow (photos then the branch point), and
 * QUESTIONNAIRE_DONE terminates it — none of them are listed here.
 */
const FLOWS: Record<ProductKind, WizardStep[]> = {
  [ProductKind.SPARE_PART]: [
    WizardStep.MODEL,
    WizardStep.CATEGORY,
    WizardStep.TITLE,
    WizardStep.DESCRIPTION,
    WizardStep.PART_NUMBER_TYPE,
    WizardStep.PRICE,
  ],
  [ProductKind.MOTOR_OIL]: [
    WizardStep.OIL_VISCOSITY,
    WizardStep.OIL_TYPE,
    WizardStep.OIL_VOLUME,
    WizardStep.TITLE,
    WizardStep.DESCRIPTION,
    WizardStep.PRICE,
  ],
};

// `isUniversalKind` is NOT defined here. Whether a kind fits every vehicle is a
// domain fact shared with the buyer catalog and the projection, so it lives in
// the kind capability table (common/product-kind.ts) and is re-exported for the
// wizard's callers. Defining it here as well is how the rule drifted before: the
// bot said one thing and the catalog card another.
export { isUniversalKind };

/**
 * The session's flow as ACTUALLY walked, with the conditional detours spliced in
 * where the session's state says they were taken. This is what both forward
 * motion and "⬅️ Назад" read, so the two can never disagree about the path:
 *   • SUBCATEGORY follows CATEGORY only when the chosen category HAS
 *     subcategories (TRANSMISSION / HEATING_AND_COOLING go straight to TITLE);
 *   • PART_NUMBER follows PART_NUMBER_TYPE only when a number was requested
 *     (type OEM/GM — a skipped number goes straight to PRICE);
 *   • OIL_VISCOSITY_CUSTOM / OIL_VOLUME_CUSTOM follow their button step only
 *     while the seller is on (or came through) the "Другое" branch.
 */
function flowSteps(session: WizardSession): WizardStep[] {
  // The shared PREFIX every flow walks before its own questions begin. BRAND is
  // the branch point; OTHER_CATEGORY is the menu the "Другое" button opens, and
  // it belongs here — NOT inside a kind's FLOWS entry — because it is the step
  // that CHOOSES the kind, so it precedes the kind being known. Putting it in
  // MOTOR_OIL's flow made it unreachable from the session that is standing on
  // it (kind is still SPARE_PART at that moment), which left `previousStep`
  // returning null and the step rendering with no "⬅️ Назад" button at all.
  //
  // The condition below is deliberately NOT a capability lookup: it asks "did
  // this dialogue go through the Другое menu", which is a fact about the SESSION's
  // path, not about what the kind is. SPARE_PART is the only kind reachable
  // without that menu, so it is the one excluded.
  const steps: WizardStep[] = [WizardStep.BRAND];
  if (
    session.step === WizardStep.OTHER_CATEGORY ||
    session.kind !== ProductKind.SPARE_PART
  ) {
    steps.push(WizardStep.OTHER_CATEGORY);
  }
  for (const step of FLOWS[session.kind]) {
    steps.push(step);
    // The subcategory question exists only for a category that HAS
    // subcategories, so it is spliced in from the answer itself: a category
    // with none (TRANSMISSION, HEATING_AND_COOLING) never grows the step, and
    // the flow continues exactly as it did before.
    if (
      step === WizardStep.CATEGORY &&
      session.category !== null &&
      hasSubcategories(session.category)
    ) {
      steps.push(WizardStep.SUBCATEGORY);
    }
    if (
      step === WizardStep.PART_NUMBER_TYPE &&
      session.partNumberType !== 'UNKNOWN'
    ) {
      steps.push(WizardStep.PART_NUMBER);
    }
    if (step === WizardStep.OIL_VISCOSITY && session.viscosityIsCustom) {
      steps.push(WizardStep.OIL_VISCOSITY_CUSTOM);
    }
    if (step === WizardStep.OIL_VOLUME && session.volumeIsCustom) {
      steps.push(WizardStep.OIL_VOLUME_CUSTOM);
    }
  }
  return steps;
}

/**
 * The step that FOLLOWS the session's current one in its flow, or
 * QUESTIONNAIRE_DONE when the flow is exhausted. Every forward transition ends
 * with `advance(session)`, so no transition hardcodes its successor and a step
 * inserted into FLOWS is picked up everywhere at once.
 */
function nextStep(session: WizardSession): WizardStep {
  const steps = flowSteps(session);
  const i = steps.indexOf(session.step);
  if (i === -1 || i === steps.length - 1) return WizardStep.QUESTIONNAIRE_DONE;
  return steps[i + 1];
}

/** Move the session to the next step of its flow. */
function advance(session: WizardSession): WizardResult {
  session.step = nextStep(session);
  return OK;
}

/**
 * The conversational state of one seller's wizard dialogue. Business state lives
 * on the ProductDraft identified by `draftId` — this object only tracks WHERE the
 * seller is and WHICH draft the answers belong to, so losing it (restart, TTL)
 * costs nothing but the dialogue position, which /start rebuilds from the draft.
 */
export interface WizardSession {
  step: WizardStep;
  /** The DB draft backing this session. Set once photos are accepted (or straight
   *  away when resuming/reopening an existing draft); null before that. */
  draftId: string | null;
  /** Which questionnaire this session runs. SPARE_PART until the seller taps
   *  "Другое" at the BRAND step and picks a category from the "Другое" menu. */
  kind: ProductKind;
  brand: string | null;
  model: string | null;
  category: PartVehicleCategory | null;
  /** The chosen subcategory, for a category that has them; null otherwise (and
   *  for kinds whose flow never asks a category at all). */
  subcategory: PartMainCategory | null;
  title: string | null;
  description: string | null;
  /** 'UNKNOWN' until the seller picks OEM/GM; Skip keeps it 'UNKNOWN'. */
  partNumberType: PartNumberType;
  partNumber: string | null;
  // ── MOTOR_OIL fields (null in every other flow) ───────────────────────────
  /** SAE grade as displayed, e.g. "5W-30" — a preset or a normalized typed one. */
  oilViscosity: string | null;
  oilType: OilType | null;
  /** Package volume in millilitres (see motor-oil-catalog). */
  oilVolumeMl: number | null;
  /** The seller chose "Другое" at the viscosity step, so the free-text step is
   *  part of their path (it must be re-visited when walking back). */
  viscosityIsCustom: boolean;
  /** Ditto for the volume step. */
  volumeIsCustom: boolean;
  price: number | null;
}

/**
 * Outcome of applying one wizard event to a session:
 *   ok      — accepted, session advanced;
 *   stale   — event doesn't belong to the current step (old button tap, photo
 *             too early, …) — ignore or send a gentle hint;
 *   invalid — input rejected; `message` is the Russian re-ask text.
 */
export type WizardResult =
  | { status: 'ok' }
  | { status: 'stale' }
  | { status: 'invalid'; message: string };

const OK: WizardResult = { status: 'ok' };
const STALE: WizardResult = { status: 'stale' };
const invalid = (message: string): WizardResult => ({
  status: 'invalid',
  message,
});

// ── Inline-button callback payloads ─────────────────────────────────────────
// Index-based so a forged/stale callback can never inject an arbitrary name:
// every payload resolves through the static wizard catalog or is rejected.
//
// VERSIONED: every payload carries CATALOG_VERSION. Brand/model indexes are only
// meaningful for the catalog revision that produced them — after WIZARD_BRANDS
// is reordered or edited, an old message's "wiz:1:b:5" would resolve to a
// DIFFERENT model. Bumping CATALOG_VERSION makes every pre-existing button stop
// matching the current-version handlers; such taps are then caught by
// WIZ_STALE_ACTION and answered with a "catalog updated, start again" notice
// instead of resolving to the wrong item. Bump it whenever WIZARD_BRANDS
// order/content changes; wizard-catalog.spec.ts reminds you to. The same applies
// to the motor-oil option lists (OIL_VISCOSITIES / OIL_TYPES / OIL_VOLUMES),
// which are index-addressed in exactly the same way.
//
// Bumped to 2 for the "Другое" branch. Brand indexes did NOT shift ("Другое" is
// its own payload kind, appended after the brand grid), so this bump is not
// about a misresolving index — it retires the in-flight buttons of a wizard whose
// session shape changed (sessions gained `kind` and the oil fields). A tap on a
// version-1 keyboard therefore lands on the "catalog updated, start again"
// notice instead of a session the new transitions would read differently.
//
// Bumped to 3 for the subcategory step. No existing index shifted either, but a
// version-2 session has no `subcategory` field and its CATEGORY answer was the
// last word on taxonomy — resuming such a dialogue under the new flow would drop
// the seller onto a question their in-flight keyboard cannot answer.
export const CATALOG_VERSION = 3;

/** Build a versioned callback payload, e.g. buildAction('b', 5) → "wiz:1:b:5". */
export function buildAction(kind: string, arg: string | number): string {
  return `wiz:${CATALOG_VERSION}:${kind}:${arg}`;
}

// Each regex pins the CURRENT version, so a button minted under an older catalog
// version does not match these — it is handled by WIZ_STALE_ACTION instead.
const V = CATALOG_VERSION;
export const WIZ_BRAND_ACTION = new RegExp(`^wiz:${V}:b:(\\d{1,2})$`);
export const WIZ_MODEL_ACTION = new RegExp(`^wiz:${V}:m:(\\d{1,2})$`);
export const WIZ_CATEGORY_ACTION = new RegExp(`^wiz:${V}:c:(\\d{1,2})$`);
// A pick from the subcategory menu — index into the CURRENT category's list.
export const WIZ_SUBCATEGORY_ACTION = new RegExp(`^wiz:${V}:sc:(\\d{1,2})$`);
export const WIZ_DESCRIPTION_SKIP = buildAction('d', 'skip');
export const WIZ_PART_NUMBER_TYPE_ACTION = new RegExp(
  `^wiz:${V}:t:(OEM|GM|SKIP)$`,
);
// "Другое" on the brand keyboard → leave the spare-parts flow.
export const WIZ_OTHER_BRAND_ACTION = buildAction('ob', '');
// A pick from the "Другое" menu — index into WIZARD_OTHER_CATEGORIES.
export const WIZ_OTHER_CATEGORY_ACTION = new RegExp(`^wiz:${V}:oc:(\\d{1,2})$`);
// Motor-oil option picks. Each carries either an index into its catalog or the
// literal "custom" for the "Другое" escape hatch (viscosity and volume only —
// oil TYPE is a closed set with no free-text branch).
export const WIZ_OIL_VISCOSITY_ACTION = new RegExp(
  `^wiz:${V}:ov:(\\d{1,2}|custom)$`,
);
export const WIZ_OIL_TYPE_ACTION = new RegExp(`^wiz:${V}:ot:(\\d{1,2})$`);
export const WIZ_OIL_VOLUME_ACTION = new RegExp(
  `^wiz:${V}:ol:(\\d{1,2}|custom)$`,
);
// "⬅️ Назад" — return to the previous wizard step. Versioned like every other
// payload so a Back tap on a message from an outdated catalog is treated as
// stale (caught by WIZ_ANY_ACTION) rather than acted on.
export const WIZ_BACK_ACTION = buildAction('back', '');

// Any wizard-shaped payload (`wiz:<version>:…`) — matches EVERY version. Register
// this AFTER the current-version handlers so it only catches taps they didn't:
// i.e. buttons from a DIFFERENT (older) CATALOG_VERSION. Used to answer a stale
// tap explicitly rather than leaving it silently inert.
export const WIZ_ANY_ACTION = /^wiz:/;

/**
 * True when a wizard callback payload belongs to a catalog version OTHER than
 * the current one (or is malformed / unversioned). Such a payload's brand/model
 * index is no longer trustworthy, so the tap must be rejected with a notice.
 */
export function isStaleCatalogPayload(payload: string): boolean {
  const m = /^wiz:(\d+):/.exec(payload);
  // No parseable version → treat as stale (e.g. a legacy "wiz:b:0" button).
  if (!m) return true;
  return Number(m[1]) !== CATALOG_VERSION;
}

/** User-facing notice for a tap on a button from an outdated catalog version. */
export const STALE_CATALOG_MESSAGE =
  'Каталог был обновлён.\n' +
  'Чтобы продолжить создание объявления, пожалуйста, нажмите /start.';

// ── Input bounds ────────────────────────────────────────────────────────────
// Title mirrors the historical guard (≥3 chars) plus the DB column cap.
const TITLE_MIN = 3;
const TITLE_MAX = 255; // Product.title VarChar(255)
// Part number: real OEM/GM catalog numbers use letters, digits, spaces, and the
// separators "-", "/", ".". Must start alphanumeric, carry at least one digit,
// and fit the DB column (Product.gmNumber / oemNumber are VarChar(50)). Internal
// single spaces are allowed ("58 09 111" / "GM 96 953 062"); they're collapsed
// on input so the stored value stays tidy.
const PART_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9\-./ ]{1,48}[A-Za-z0-9]$/;
const PART_NUMBER_MAX = 50;
// Stock.priceUzs is Decimal(14,2) → the integer part fits 12 digits.
const MAX_PRICE_UZS = 999_999_999_999;

// ── Session store ───────────────────────────────────────────────────────────
export class WizardSessionStore {
  private readonly sessions = new Map<number, WizardSession>();

  /**
   * Start (or restart) the wizard: begins at PHOTOS_FIRST so the seller uploads
   * photos before any question. Once photos arrive the service creates the draft
   * (setting `draftId`) and advances to BRAND.
   */
  start(tgUserId: number): WizardSession {
    const session: WizardSession = {
      step: WizardStep.PHOTOS_FIRST,
      draftId: null,
      // Every session begins on the spare-parts flow; "Другое" switches it.
      kind: ProductKind.SPARE_PART,
      brand: null,
      model: null,
      category: null,
      subcategory: null,
      title: null,
      description: null,
      partNumberType: 'UNKNOWN',
      partNumber: null,
      oilViscosity: null,
      oilType: null,
      oilVolumeMl: null,
      viscosityIsCustom: false,
      volumeIsCustom: false,
      price: null,
    };
    this.sessions.set(tgUserId, session);
    return session;
  }

  /**
   * Re-insert an existing session object, used when the service rebuilds the
   * dialogue from a draft: /start resume, and the preview's "⬅️ Назад" edit. The
   * draft supplies every field; this only restores the conversational position.
   * Replaces any current session for the user, mirroring `start`'s
   * single-session-per-user contract.
   */
  restore(tgUserId: number, session: WizardSession): void {
    this.sessions.set(tgUserId, session);
  }

  get(tgUserId: number): WizardSession | undefined {
    return this.sessions.get(tgUserId);
  }

  delete(tgUserId: number): void {
    this.sessions.delete(tgUserId);
  }

  /**
   * Delete only if the stored session IS `expected` (identity check). Protects the
   * hand-off at QUESTIONNAIRE_DONE: if the seller sent /start while the images were
   * still processing, the fresh session must survive the finishing draft's cleanup.
   */
  deleteIf(tgUserId: number, expected: WizardSession): void {
    if (this.sessions.get(tgUserId) === expected)
      this.sessions.delete(tgUserId);
  }

  clear(): void {
    this.sessions.clear();
  }
}

// ── Transitions ─────────────────────────────────────────────────────────────
// Every transition follows the same contract: reject anything that isn't the
// session's current step (a stale/forged tap), record the answer, then hand the
// step pointer to `advance` so the flow definition — not the transition —
// decides what comes next.

export function selectBrand(
  session: WizardSession,
  brandIndex: number,
): WizardResult {
  if (session.step !== WizardStep.BRAND) return STALE;
  const brand = WIZARD_BRANDS[brandIndex];
  if (!brand) return STALE;
  // A real car brand keeps (or returns) the session on the spare-parts flow —
  // "returns" matters when the seller walked back from the "Другое" menu.
  session.kind = ProductKind.SPARE_PART;
  session.brand = brand.name;
  return advance(session);
}

/**
 * "Другое" at the BRAND step: this listing is not a spare part for a specific
 * car. The vehicle fields are cleared (a previous brand pick must not survive
 * into a non-vehicle listing) and the "Другое" menu is shown. The KIND is not
 * decided yet — {@link selectOtherCategory} does that.
 */
export function selectOtherBrand(session: WizardSession): WizardResult {
  if (session.step !== WizardStep.BRAND) return STALE;
  session.brand = null;
  session.model = null;
  session.category = null;
  session.subcategory = null;
  session.step = WizardStep.OTHER_CATEGORY;
  return OK;
}

/**
 * A pick from the "Другое" menu — this is where the session's KIND is set, and
 * therefore where it adopts that kind's questionnaire. Spare-part-only fields
 * are cleared so a seller who backtracked out of the parts flow cannot carry a
 * part number or vehicle category into, say, a motor oil.
 */
export function selectOtherCategory(
  session: WizardSession,
  categoryIndex: number,
): WizardResult {
  if (session.step !== WizardStep.OTHER_CATEGORY) return STALE;
  const chosen = WIZARD_OTHER_CATEGORIES[categoryIndex];
  if (!chosen) return STALE;
  session.kind = chosen.kind;
  session.brand = null;
  session.model = null;
  session.category = null;
  session.subcategory = null;
  session.partNumberType = 'UNKNOWN';
  session.partNumber = null;
  return advance(session);
}

export function selectModel(
  session: WizardSession,
  modelIndex: number,
): WizardResult {
  if (session.step !== WizardStep.MODEL || session.brand === null) return STALE;
  const models =
    WIZARD_BRANDS.find((b) => b.name === session.brand)?.models ?? [];
  const model = models[modelIndex];
  if (!model) return STALE;
  session.model = model;
  return advance(session);
}

export function selectCategory(
  session: WizardSession,
  categoryIndex: number,
): WizardResult {
  if (session.step !== WizardStep.CATEGORY) return STALE;
  const category = WIZARD_CATEGORIES[categoryIndex];
  if (!category) return STALE;
  // A subcategory belongs to the category it was picked under, so re-answering
  // this step drops it: the seller may have walked back and chosen a DIFFERENT
  // category, whose subcategory list this value is not part of. `advance` then
  // lands on SUBCATEGORY (when the new category has any) or on the step that
  // followed CATEGORY before this step existed.
  session.category = category.value;
  session.subcategory = null;
  return advance(session);
}

/** A pick from the subcategory menu of the category chosen one step earlier. */
export function selectSubcategory(
  session: WizardSession,
  subcategoryIndex: number,
): WizardResult {
  if (session.step !== WizardStep.SUBCATEGORY || session.category === null)
    return STALE;
  // Resolved against the CURRENT category's own list, so an index from another
  // category's (stale) keyboard cannot select a foreign subcategory.
  const subcategory = subcategoriesOf(session.category)[subcategoryIndex];
  if (!subcategory) return STALE;
  session.subcategory = subcategory.value;
  return advance(session);
}

// ── Motor-oil transitions ───────────────────────────────────────────────────
/**
 * Viscosity from a preset button, or 'custom' for the "Другое" escape hatch
 * (which routes to the free-text step instead of answering the question).
 */
export function selectOilViscosity(
  session: WizardSession,
  choice: number | 'custom',
): WizardResult {
  if (session.step !== WizardStep.OIL_VISCOSITY) return STALE;
  if (choice === 'custom') {
    // Splice the free-text step into the flow, then advance ONTO it.
    session.viscosityIsCustom = true;
    session.oilViscosity = null;
    return advance(session);
  }
  const viscosity = OIL_VISCOSITIES[choice];
  if (!viscosity) return STALE;
  // A preset answer removes the free-text detour (the seller may have taken it
  // before walking back), so the path forward matches the answer given.
  session.viscosityIsCustom = false;
  session.oilViscosity = viscosity;
  return advance(session);
}

export function inputOilViscosity(
  session: WizardSession,
  raw: string,
): WizardResult {
  if (session.step !== WizardStep.OIL_VISCOSITY_CUSTOM) return STALE;
  const viscosity = normalizeViscosity(raw);
  if (viscosity === null) {
    return invalid(
      '❌ Не удалось распознать вязкость. Введите её в формате 5W-30 (например: 0W-16 или 20W-50).',
    );
  }
  session.oilViscosity = viscosity;
  return advance(session);
}

export function selectOilType(
  session: WizardSession,
  typeIndex: number,
): WizardResult {
  if (session.step !== WizardStep.OIL_TYPE) return STALE;
  const type = OIL_TYPES[typeIndex];
  if (!type) return STALE;
  session.oilType = type.value;
  return advance(session);
}

/** Volume from a preset button, or 'custom' → the free-text litres step. */
export function selectOilVolume(
  session: WizardSession,
  choice: number | 'custom',
): WizardResult {
  if (session.step !== WizardStep.OIL_VOLUME) return STALE;
  if (choice === 'custom') {
    session.volumeIsCustom = true;
    session.oilVolumeMl = null;
    return advance(session);
  }
  const volume = OIL_VOLUMES[choice];
  if (!volume) return STALE;
  session.volumeIsCustom = false;
  session.oilVolumeMl = volume.value;
  return advance(session);
}

export function inputOilVolume(
  session: WizardSession,
  raw: string,
): WizardResult {
  if (session.step !== WizardStep.OIL_VOLUME_CUSTOM) return STALE;
  const ml = parseVolumeLitres(raw);
  if (ml === null) {
    return invalid(
      '❌ Не удалось распознать объём. Введите его в литрах, например: 3 или 0,5',
    );
  }
  session.oilVolumeMl = ml;
  return advance(session);
}

export function inputTitle(session: WizardSession, raw: string): WizardResult {
  if (session.step !== WizardStep.TITLE) return STALE;
  // Titles are single-line (preview caption + VarChar column): collapse any
  // internal whitespace/newlines the seller typed.
  const title = raw.replace(/\s+/g, ' ').trim();
  if (title.startsWith('/')) {
    return invalid(
      '❌ Это похоже на команду. Введите название товара текстом.',
    );
  }
  if (title.length < TITLE_MIN) {
    return invalid(
      `❌ Название слишком короткое — минимум ${TITLE_MIN} символа. Введите название ещё раз.`,
    );
  }
  if (title.length > TITLE_MAX) {
    return invalid(
      `❌ Название слишком длинное — максимум ${TITLE_MAX} символов. Введите короче.`,
    );
  }
  session.title = title;
  return advance(session);
}

export function inputDescription(
  session: WizardSession,
  raw: string,
): WizardResult {
  if (session.step !== WizardStep.DESCRIPTION) return STALE;
  const description = raw.trim();
  if (description.startsWith('/')) {
    return invalid(
      '❌ Это похоже на команду. Введите описание текстом или нажмите «Пропустить».',
    );
  }
  if (description.length === 0) {
    return invalid(
      '❌ Описание не может быть пустым. Введите текст или нажмите «Пропустить».',
    );
  }
  session.description = description;
  return advance(session);
}

export function skipDescription(session: WizardSession): WizardResult {
  if (session.step !== WizardStep.DESCRIPTION) return STALE;
  session.description = null;
  return advance(session);
}

export function choosePartNumberType(
  session: WizardSession,
  choice: 'OEM' | 'GM' | 'SKIP',
): WizardResult {
  if (session.step !== WizardStep.PART_NUMBER_TYPE) return STALE;
  if (choice === 'SKIP') {
    // No number at all: the type stays UNKNOWN, which is exactly what keeps
    // PART_NUMBER out of the flow (see flowSteps) — so `advance` skips it.
    session.partNumberType = 'UNKNOWN';
    session.partNumber = null;
    return advance(session);
  }
  session.partNumberType = choice;
  return advance(session);
}

export function inputPartNumber(
  session: WizardSession,
  raw: string,
): WizardResult {
  if (session.step !== WizardStep.PART_NUMBER) return STALE;
  // Collapse internal whitespace runs to single spaces so "58 09  111" stores as
  // "58 09 111", then validate the tidy value.
  const number = raw.replace(/\s+/g, ' ').trim();
  if (
    number.length < 3 ||
    number.length > PART_NUMBER_MAX ||
    !PART_NUMBER_RE.test(number) ||
    !/\d/.test(number)
  ) {
    return invalid(
      '❌ Неверный формат номера. Введите 3–50 символов: буквы, цифры, пробел, «-», «.», «/». Например: 96535062 или 58101-2VA00',
    );
  }
  session.partNumber = number;
  return advance(session);
}

export function inputPrice(session: WizardSession, raw: string): WizardResult {
  if (session.step !== WizardStep.PRICE) return STALE;
  // Same shared parser the whole backend uses ("250 000", "250.000 сум", …).
  const price = parsePrice(raw);
  if (price === null) {
    return invalid(
      '❌ Не удалось распознать цену. Введите число в сумах, например: 250 000',
    );
  }
  if (price > MAX_PRICE_UZS) {
    return invalid(
      '❌ Слишком большая цена. Проверьте значение и введите ещё раз.',
    );
  }
  session.price = price;
  // PRICE is the last QUESTION of every flow, so `advance` lands on
  // QUESTIONNAIRE_DONE: the form is complete. Photos were uploaded first and are
  // already processing — the coordinator handles the rendezvous and decides when
  // the preview appears.
  return advance(session);
}

/**
 * PHOTOS_FIRST → BRAND: called once the uploaded photos have been accepted and the
 * backing draft created, so the questionnaire begins while the images process in
 * the background. Stale outside the PHOTOS_FIRST step.
 */
export function beginQuestionnaire(session: WizardSession): WizardResult {
  if (session.step !== WizardStep.PHOTOS_FIRST) return STALE;
  session.step = WizardStep.BRAND;
  return OK;
}

/**
 * The step the "⬅️ Назад" button returns to from the CURRENT step, or `null`
 * when there is nowhere to go back.
 *
 * Read straight off the session's own flow ({@link flowSteps}) — the SAME list
 * forward motion uses — so back and forward can never disagree about the path.
 * Because that list is built from session STATE, the conditional detours resolve
 * correctly for free: PRICE goes back to PART_NUMBER only when a number was
 * actually asked for (OEM/GM), and to PART_NUMBER_TYPE when the seller skipped
 * it; TITLE goes back to CATEGORY for a spare part but to OIL_VOLUME for an oil.
 *
 * Null for: the first step of a flow (BRAND — photos precede it but are not a
 * question), PHOTOS_FIRST, and QUESTIONNAIRE_DONE (terminal; the coordinator
 * owns the flow from there).
 */
export function previousStep(session: WizardSession): WizardStep | null {
  const steps = flowSteps(session);
  const i = steps.indexOf(session.step);
  if (i <= 0) return null;
  return steps[i - 1];
}

/**
 * Move one step back. Only the `step` pointer moves — already-entered fields are
 * PRESERVED (the requirement: going back must not lose data, and going forward
 * again keeps everything). A value is simply overwritten if the seller re-enters
 * it. Returns `stale` when there is no previous step (first step / processing),
 * so a stray Back tap is ignored rather than corrupting the session.
 */
export function goBack(session: WizardSession): WizardResult {
  const target = previousStep(session);
  if (target === null) return STALE;
  session.step = target;
  return OK;
}

// ── Keyboards & prompts ─────────────────────────────────────────────────────
type InlineButton = ReturnType<typeof Markup.button.callback>;
type InlineKeyboard = ReturnType<typeof Markup.inlineKeyboard>;

/** The "⬅️ Назад" button, shown on every step that has a previous one. */
const backButton = (): InlineButton =>
  Markup.button.callback('⬅️ Назад', WIZ_BACK_ACTION);

/**
 * Assemble an inline keyboard from `rows`, appending a "⬅️ Назад" row iff the
 * current step has a previous one (i.e. it is not the first step). This is the
 * single place the Back button is attached, so every wizard keyboard — including
 * the text steps that otherwise show no buttons — gets it consistently.
 */
function withBack(
  session: WizardSession,
  rows: InlineButton[][],
): InlineKeyboard {
  const all = previousStep(session) !== null ? [...rows, [backButton()]] : rows;
  return Markup.inlineKeyboard(all);
}

/** Lay buttons out in rows of `perRow` (Telegram renders them as a grid). */
function grid<T>(items: T[], perRow: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += perRow)
    rows.push(items.slice(i, i + perRow));
  return rows;
}

/**
 * The car brands, two per row, followed by a full-width "Другое" row that leaves
 * the spare-parts flow. "Другое" is its own payload kind (not a brand index), so
 * adding it shifts no existing brand index.
 */
export function brandKeyboard(session: WizardSession): InlineKeyboard {
  const buttons = WIZARD_BRANDS.map((b, i) =>
    Markup.button.callback(b.name, buildAction('b', i)),
  );
  return withBack(session, [
    ...grid(buttons, 2),
    [Markup.button.callback(OTHER_BRAND_LABEL, WIZ_OTHER_BRAND_ACTION)],
  ]);
}

/** The "Другое" menu: one button per non-spare-part category. */
export function otherCategoryKeyboard(session: WizardSession): InlineKeyboard {
  const buttons = WIZARD_OTHER_CATEGORIES.map((c, i) =>
    Markup.button.callback(c.label, buildAction('oc', i)),
  );
  return withBack(session, grid(buttons, 1));
}

// ── Motor-oil keyboards ─────────────────────────────────────────────────────
/** Viscosity presets (three per row) plus the "Другое" free-text escape hatch. */
export function oilViscosityKeyboard(session: WizardSession): InlineKeyboard {
  const buttons = OIL_VISCOSITIES.map((v, i) =>
    Markup.button.callback(v, buildAction('ov', i)),
  );
  return withBack(session, [
    ...grid(buttons, 3),
    [Markup.button.callback(OTHER_BRAND_LABEL, buildAction('ov', 'custom'))],
  ]);
}

/** Oil type — a closed set, so one button per row and no free-text option. */
export function oilTypeKeyboard(session: WizardSession): InlineKeyboard {
  const buttons = OIL_TYPES.map((t, i) =>
    Markup.button.callback(t.label, buildAction('ot', i)),
  );
  return withBack(session, grid(buttons, 1));
}

/** Volume presets (two per row) plus the "Другое" free-text escape hatch. */
export function oilVolumeKeyboard(session: WizardSession): InlineKeyboard {
  const buttons = OIL_VOLUMES.map((v, i) =>
    Markup.button.callback(v.label, buildAction('ol', i)),
  );
  return withBack(session, [
    ...grid(buttons, 2),
    [Markup.button.callback(OTHER_BRAND_LABEL, buildAction('ol', 'custom'))],
  ]);
}

export function modelKeyboard(
  session: WizardSession,
  brandName: string,
): InlineKeyboard {
  const models = WIZARD_BRANDS.find((b) => b.name === brandName)?.models ?? [];
  const buttons = models.map((m, i) =>
    Markup.button.callback(m, buildAction('m', i)),
  );
  return withBack(session, grid(buttons, 2));
}

export function categoryKeyboard(session: WizardSession): InlineKeyboard {
  const buttons = WIZARD_CATEGORIES.map((c, i) =>
    Markup.button.callback(c.label, buildAction('c', i)),
  );
  return withBack(session, grid(buttons, 2));
}

/**
 * The subcategories of the category chosen at the previous step, two per row.
 * Empty (Back only) when there is no category — unreachable in practice, since
 * the step is only spliced into the flow once a category with subcategories has
 * been picked.
 */
export function subcategoryKeyboard(session: WizardSession): InlineKeyboard {
  const buttons = (
    session.category !== null ? subcategoriesOf(session.category) : []
  ).map((s, i) => Markup.button.callback(s.label, buildAction('sc', i)));
  return withBack(session, grid(buttons, 2));
}

export function descriptionKeyboard(session: WizardSession): InlineKeyboard {
  return withBack(session, [
    [Markup.button.callback('⏭ Пропустить', WIZ_DESCRIPTION_SKIP)],
  ]);
}

export function partNumberTypeKeyboard(session: WizardSession): InlineKeyboard {
  return withBack(session, [
    [
      Markup.button.callback('OEM', buildAction('t', 'OEM')),
      Markup.button.callback('GM', buildAction('t', 'GM')),
    ],
    [Markup.button.callback('⏭ Пропустить', buildAction('t', 'SKIP'))],
  ]);
}

/**
 * Keyboard for a step whose only control is "⬅️ Назад" — the text-input steps
 * (title, part number, price). `withBack` omits the button on a step with no
 * previous one, yielding an empty keyboard (never rendered — see stepPrompt).
 */
export function backOnlyKeyboard(session: WizardSession): InlineKeyboard {
  return withBack(session, []);
}

export interface StepPrompt {
  text: string;
  keyboard?: InlineKeyboard;
}

/**
 * The TITLE step is shared by every flow but its EXAMPLE is kind-specific — a
 * seller listing oil should not be shown "Передний амортизатор". Kept as a table
 * so a new kind supplies its example here instead of branching in stepPrompt.
 */
const TITLE_PROMPTS: Record<ProductKind, string> = {
  [ProductKind.SPARE_PART]:
    '✏️ Введите название товара.\nПример: Передний амортизатор',
  [ProductKind.MOTOR_OIL]:
    '✏️ Введите название товара.\n' +
    'Примеры:\n' +
    '• Mobil 1 ESP 5W-30 4L\n' +
    '• Shell Helix Ultra 5W-40\n' +
    '• ZIC X9 5W-30',
};

/** The message (and inline keyboard, if any) that asks for the current step. */
export function stepPrompt(session: WizardSession): StepPrompt {
  switch (session.step) {
    case WizardStep.BRAND:
      // First step — brandKeyboard() carries no Back button (nothing to go back to).
      return {
        text: '🚗 Выберите марку автомобиля:',
        keyboard: brandKeyboard(session),
      };
    case WizardStep.MODEL:
      return {
        text: `🚗 Марка: ${session.brand}.\nТеперь выберите модель:`,
        keyboard: modelKeyboard(session, session.brand ?? ''),
      };
    case WizardStep.CATEGORY:
      return {
        text: '🗂 Выберите категорию запчасти:',
        keyboard: categoryKeyboard(session),
      };
    case WizardStep.SUBCATEGORY:
      return {
        text: '🗂 Выберите подкатегорию:',
        keyboard: subcategoryKeyboard(session),
      };
    case WizardStep.OTHER_CATEGORY:
      return {
        text: '🗂 Выберите категорию товара:',
        keyboard: otherCategoryKeyboard(session),
      };
    case WizardStep.OIL_VISCOSITY:
      return {
        text: '🛢 Выберите вязкость масла:',
        keyboard: oilViscosityKeyboard(session),
      };
    case WizardStep.OIL_VISCOSITY_CUSTOM:
      return {
        text: '🛢 Введите вязкость масла.\nПример: 0W-16',
        keyboard: backOnlyKeyboard(session),
      };
    case WizardStep.OIL_TYPE:
      return {
        text: '🛢 Выберите тип масла:',
        keyboard: oilTypeKeyboard(session),
      };
    case WizardStep.OIL_VOLUME:
      return {
        text: '🛢 Выберите объём:',
        keyboard: oilVolumeKeyboard(session),
      };
    case WizardStep.OIL_VOLUME_CUSTOM:
      return {
        text: '🛢 Введите объём в литрах.\nПример: 3',
        keyboard: backOnlyKeyboard(session),
      };
    case WizardStep.TITLE:
      return {
        text: TITLE_PROMPTS[session.kind],
        keyboard: backOnlyKeyboard(session),
      };
    case WizardStep.DESCRIPTION:
      return {
        text: '📝 Введите описание товара или нажмите «Пропустить».',
        keyboard: descriptionKeyboard(session),
      };
    case WizardStep.PART_NUMBER_TYPE:
      return {
        text: '🔢 Укажите тип номера детали или нажмите «Пропустить».',
        keyboard: partNumberTypeKeyboard(session),
      };
    case WizardStep.PART_NUMBER:
      return {
        text: `🔢 Введите ${session.partNumberType} номер детали.\nПример: 96535062`,
        keyboard: backOnlyKeyboard(session),
      };
    case WizardStep.PRICE:
      return {
        text: '💰 Введите цену в сумах.\nПример: 250 000',
        keyboard: backOnlyKeyboard(session),
      };
    case WizardStep.PHOTOS_FIRST:
      // Entry step: photos before any question. No Back button.
      return {
        text:
          '📸 Сначала отправьте фотографии товара — одно фото или альбом до 10 фото.\n' +
          'Пока мы их обрабатываем, вы заполните информацию о товаре.',
      };
    case WizardStep.QUESTIONNAIRE_DONE:
      // Form finished; the coordinator shows the preview as soon as the photos are
      // ready. This holding message only appears if processing is still running.
      return { text: '⏳ Завершаем обработку фото…' };
  }
}

// ── Preview rendering ───────────────────────────────────────────────────────
/**
 * The KIND-SPECIFIC lines of a listing's preview caption, in display order. The
 * shared lines (title, description, price) are rendered by the caller around
 * these, so each kind declares only what is peculiar to it and a new kind adds a
 * branch here rather than editing the caption builder.
 *
 * `formatVehicle` is injected because the vehicle line is assembled from parse
 * metadata that lives in the telegram service — this module stays I/O- and
 * metadata-free.
 */
export function previewLines(
  listing: {
    kind: ProductKind;
    vehicleCategoryLabel: string;
    partNumberLabel: string;
    partNumber: string | null;
    oilViscosity: string | null;
    oilType: OilType | null;
    oilVolumeMl: number | null;
  },
  vehicleLine: string,
): string[] {
  const caps = capabilitiesOf(listing.kind);
  const lines: string[] = [];

  // Which SHARED lines appear is read from the capability table, never from a
  // local kind check — so a kind without fitment automatically shows no vehicle
  // line, and one without part numbers shows no number line. This is the same
  // table the buyer card and the commit path read.
  if (caps.hasVehicleFitment) lines.push(`🚗 *Автомобиль:* ${vehicleLine}`);
  if (caps.hasVehicleCategory) {
    lines.push(`🗂 *Категория:* ${listing.vehicleCategoryLabel}`);
  }
  if (caps.hasPartNumbers) {
    lines.push(`🔢 *${listing.partNumberLabel}:* ${listing.partNumber ?? '—'}`);
  }

  // The kind's OWN attribute lines. This switch is exhaustive, so a new kind
  // cannot compile until it states how its attributes are rendered — the one
  // place per-kind preview knowledge is allowed to live.
  switch (listing.kind) {
    case ProductKind.MOTOR_OIL:
      lines.push(
        `🛢 *Вязкость:* ${listing.oilViscosity ?? '—'}`,
        `🧪 *Тип масла:* ${listing.oilType ? OIL_TYPE_LABELS[listing.oilType] : '—'}`,
        `🧴 *Объём:* ${listing.oilVolumeMl !== null ? formatVolume(listing.oilVolumeMl) : '—'}`,
      );
      break;
    case ProductKind.SPARE_PART:
      // No attributes beyond the shared lines above.
      break;
  }

  return lines;
}
