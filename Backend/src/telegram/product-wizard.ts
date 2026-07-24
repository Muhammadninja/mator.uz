// src/telegram/product-wizard.ts
//
// Finite-state machine for the step-by-step product-creation wizard:
//
//   BRAND → MODEL → CATEGORY → TITLE → DESCRIPTION → PART_NUMBER_TYPE
//     → [PART_NUMBER] → PRICE → PHOTOS → PROCESSING → (pending confirmation)
//
// Brand, model, category and part-number type come ONLY from inline buttons
// (the seller never types them); title / part number / price are validated text
// inputs; description is text or an explicit Skip. Photos are handled by the
// existing image pipeline in TelegramService — once they arrive the session is
// consumed and the flow hands over to the existing preview/confirm machinery.
//
// This module is pure state + validation + prompt/keyboard builders (no
// Telegraf handlers, no I/O) so the whole FSM is unit-testable. Sessions are
// in-memory, one per Telegram user, replaced by /start and deleted on hand-off
// — they hold no uploaded assets, so no TTL/cleanup is required (unlike the
// pending-confirmation sessions, which own Cloudinary uploads).

import { PartVehicleCategory } from '@prisma/client';
import { Markup } from 'telegraf';
import type { PartNumberType } from '../ai/part-parser.types';
import { parsePrice } from '../ai/price-parser';
import { WIZARD_BRANDS, WIZARD_CATEGORIES } from './wizard-catalog';

export enum WizardStep {
  /** Photos-first entry (PARALLEL flow only): the very first thing the seller does
   *  is upload photos. Once they arrive, image processing is kicked off in the
   *  background (BullMQ) and the FSM jumps straight to BRAND so the questionnaire
   *  runs while the images process. Not used by the legacy (photos-last) flow. */
  PHOTOS_FIRST = 'PHOTOS_FIRST',
  BRAND = 'BRAND',
  MODEL = 'MODEL',
  CATEGORY = 'CATEGORY',
  TITLE = 'TITLE',
  DESCRIPTION = 'DESCRIPTION',
  PART_NUMBER_TYPE = 'PART_NUMBER_TYPE',
  PART_NUMBER = 'PART_NUMBER',
  PRICE = 'PRICE',
  PHOTOS = 'PHOTOS',
  /** Photos received; image pipeline running. Blocks further input until the
   *  preview is sent (→ session deleted) or processing fails (→ PHOTOS).
   *  LEGACY flow only. */
  PROCESSING = 'PROCESSING',
  /** Questionnaire finished (PARALLEL flow only): every form field is collected.
   *  The wizard's work is done; the draft coordinator now owns the rendezvous with
   *  image processing and decides when to show the preview. Terminal for the FSM. */
  QUESTIONNAIRE_DONE = 'QUESTIONNAIRE_DONE',
}

/**
 * Which product-creation flow a session belongs to:
 *   • 'legacy'   — the original synchronous, photos-LAST flow (BRAND→…→PRICE→PHOTOS
 *                  →PROCESSING). Kept behind the PARALLEL_DRAFT_FLOW flag for rollback.
 *   • 'parallel' — the photos-FIRST flow (PHOTOS_FIRST→BRAND→…→PRICE→QUESTIONNAIRE_DONE)
 *                  where images process in the background via the DB draft.
 * The questionnaire steps (BRAND→…→PRICE) are IDENTICAL in both; the flow only
 * changes the entry point and what happens after PRICE.
 */
export type WizardFlow = 'legacy' | 'parallel';

/** Everything the wizard collects (the requirement's FSM fields). */
export interface WizardSession {
  step: WizardStep;
  /** Which flow this session runs (default 'legacy' for back-compat). */
  flow: WizardFlow;
  /** PARALLEL flow only: the DB draft id backing this session (created once photos
   *  are accepted). null for legacy sessions and before photos arrive. */
  draftId: string | null;
  brand: string | null;
  model: string | null;
  category: PartVehicleCategory | null;
  title: string | null;
  description: string | null;
  /** 'UNKNOWN' until the seller picks OEM/GM; Skip keeps it 'UNKNOWN'. */
  partNumberType: PartNumberType;
  partNumber: string | null;
  price: number | null;
  /**
   * Already-processed photos carried back when the seller returns from the
   * preview ("⬅️ Назад"). Their presence means the PHOTOS step is ALREADY
   * satisfied by these Cloudinary assets — editing text/price must NOT re-run
   * the image pipeline, so the wizard reuses them and jumps straight to a new
   * preview. Empty for a first-time listing (photos not uploaded yet) and after
   * "🖼 Изменить фото" clears them to force a fresh upload. `processedUrls` and
   * `publicIds` are index-aligned (URL ↔ its Cloudinary public_id).
   */
  processedUrls: string[];
  publicIds: string[];
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
// order/content changes; wizard-catalog.spec.ts reminds you to.
export const CATALOG_VERSION = 1;

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
export const WIZ_DESCRIPTION_SKIP = buildAction('d', 'skip');
export const WIZ_PART_NUMBER_TYPE_ACTION = new RegExp(
  `^wiz:${V}:t:(OEM|GM|SKIP)$`,
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

  /** Build a fresh session with the given flow + starting step (all fields empty). */
  private fresh(flow: WizardFlow, step: WizardStep): WizardSession {
    return {
      step,
      flow,
      draftId: null,
      brand: null,
      model: null,
      category: null,
      title: null,
      description: null,
      partNumberType: 'UNKNOWN',
      partNumber: null,
      price: null,
      processedUrls: [],
      publicIds: [],
    };
  }

  /** Start (or restart) the LEGACY (photos-last) wizard: begins at BRAND. */
  start(tgUserId: number): WizardSession {
    const session = this.fresh('legacy', WizardStep.BRAND);
    this.sessions.set(tgUserId, session);
    return session;
  }

  /**
   * Start (or restart) the PARALLEL (photos-first) wizard: begins at PHOTOS_FIRST
   * so the seller uploads photos before any question. Once photos arrive the
   * service creates the draft (setting `draftId`) and advances to BRAND.
   */
  startParallel(tgUserId: number): WizardSession {
    const session = this.fresh('parallel', WizardStep.PHOTOS_FIRST);
    this.sessions.set(tgUserId, session);
    return session;
  }

  /**
   * Re-insert an existing session object (used when the seller taps "⬅️ Назад"
   * on the preview: the service rebuilds a WizardSession from the pending draft
   * and restores it here so the wizard continues from where it left off — same
   * data, already-processed photos preserved). Replaces any current session for
   * the user, mirroring `start`'s single-session-per-user contract.
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
   * Delete only if the stored session IS `expected` (identity check). Protects
   * an async hand-off: if the seller restarted the wizard while photos were
   * processing, the fresh session must survive the old flow's cleanup.
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
export function selectBrand(
  session: WizardSession,
  brandIndex: number,
): WizardResult {
  if (session.step !== WizardStep.BRAND) return STALE;
  const brand = WIZARD_BRANDS[brandIndex];
  if (!brand) return STALE;
  session.brand = brand.name;
  session.step = WizardStep.MODEL;
  return OK;
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
  session.step = WizardStep.CATEGORY;
  return OK;
}

export function selectCategory(
  session: WizardSession,
  categoryIndex: number,
): WizardResult {
  if (session.step !== WizardStep.CATEGORY) return STALE;
  const category = WIZARD_CATEGORIES[categoryIndex];
  if (!category) return STALE;
  session.category = category.value;
  session.step = WizardStep.TITLE;
  return OK;
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
  session.step = WizardStep.DESCRIPTION;
  return OK;
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
  session.step = WizardStep.PART_NUMBER_TYPE;
  return OK;
}

export function skipDescription(session: WizardSession): WizardResult {
  if (session.step !== WizardStep.DESCRIPTION) return STALE;
  session.description = null;
  session.step = WizardStep.PART_NUMBER_TYPE;
  return OK;
}

export function choosePartNumberType(
  session: WizardSession,
  choice: 'OEM' | 'GM' | 'SKIP',
): WizardResult {
  if (session.step !== WizardStep.PART_NUMBER_TYPE) return STALE;
  if (choice === 'SKIP') {
    // No number at all: type stays UNKNOWN and the number step is skipped.
    session.partNumberType = 'UNKNOWN';
    session.partNumber = null;
    session.step = WizardStep.PRICE;
    return OK;
  }
  session.partNumberType = choice;
  session.step = WizardStep.PART_NUMBER;
  return OK;
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
  session.step = WizardStep.PRICE;
  return OK;
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
  // PRICE is the last QUESTION in both flows. What comes AFTER it differs:
  //   • legacy   → PHOTOS (the seller now uploads photos, processed synchronously).
  //   • parallel → QUESTIONNAIRE_DONE (form complete; photos were uploaded first and
  //     are already processing — the coordinator handles the rendezvous/preview).
  session.step =
    session.flow === 'parallel'
      ? WizardStep.QUESTIONNAIRE_DONE
      : WizardStep.PHOTOS;
  return OK;
}

/**
 * PHOTOS_FIRST → BRAND (PARALLEL flow): called once the uploaded photos have been
 * accepted and the backing draft created, so the questionnaire begins while the
 * images process in the background. Stale outside the PHOTOS_FIRST step.
 */
export function beginQuestionnaire(session: WizardSession): WizardResult {
  if (session.step !== WizardStep.PHOTOS_FIRST) return STALE;
  session.step = WizardStep.BRAND;
  return OK;
}

/** PHOTOS → PROCESSING; blocks a second album from racing the first. (LEGACY.) */
export function beginProcessing(session: WizardSession): WizardResult {
  if (session.step !== WizardStep.PHOTOS) return STALE;
  session.step = WizardStep.PROCESSING;
  return OK;
}

/** PROCESSING → PHOTOS after a failed image run, so the seller can retry. */
export function backToPhotos(session: WizardSession): WizardResult {
  if (session.step !== WizardStep.PROCESSING) return STALE;
  session.step = WizardStep.PHOTOS;
  return OK;
}

/**
 * The step the "⬅️ Назад" button returns to from the CURRENT step, or `null`
 * when there is nowhere to go back (the first step BRAND, and the transient
 * PROCESSING state which blocks input while photos upload).
 *
 * Derived from session STATE, not just the step, so the OEM/GM branch resolves
 * correctly: PRICE goes back to PART_NUMBER only when a number was actually
 * asked for (partNumberType is OEM/GM); when the seller skipped the number,
 * PRICE goes back to PART_NUMBER_TYPE, mirroring the forward path exactly.
 */
export function previousStep(session: WizardSession): WizardStep | null {
  switch (session.step) {
    case WizardStep.MODEL:
      return WizardStep.BRAND;
    case WizardStep.CATEGORY:
      return WizardStep.MODEL;
    case WizardStep.TITLE:
      return WizardStep.CATEGORY;
    case WizardStep.DESCRIPTION:
      return WizardStep.TITLE;
    case WizardStep.PART_NUMBER_TYPE:
      return WizardStep.DESCRIPTION;
    case WizardStep.PART_NUMBER:
      return WizardStep.PART_NUMBER_TYPE;
    case WizardStep.PRICE:
      // Only OEM/GM listings passed through the PART_NUMBER step; a skipped
      // number came straight from PART_NUMBER_TYPE.
      return session.partNumberType === 'UNKNOWN'
        ? WizardStep.PART_NUMBER_TYPE
        : WizardStep.PART_NUMBER;
    case WizardStep.PHOTOS:
      return WizardStep.PRICE;
    // No previous step: BRAND (first question) and the transient PROCESSING state,
    // plus the parallel-flow endpoints — PHOTOS_FIRST (very first step) and
    // QUESTIONNAIRE_DONE (terminal; the coordinator owns the flow now).
    case WizardStep.BRAND:
    case WizardStep.PROCESSING:
    case WizardStep.PHOTOS_FIRST:
    case WizardStep.QUESTIONNAIRE_DONE:
      return null;
  }
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

/**
 * True when the session already carries processed, uploaded photos (the seller
 * returned from the preview via "⬅️ Назад"). In that case editing text/price
 * must NOT re-run the image pipeline: the PHOTOS step is already satisfied, so
 * the flow reuses these assets and rebuilds the preview directly.
 */
export function hasProcessedPhotos(session: WizardSession): boolean {
  return session.processedUrls.length > 0;
}

/**
 * "🖼 Изменить фото": drop the carried-over photos so the PHOTOS step demands a
 * fresh upload (which re-runs the full pipeline). Only the in-session references
 * are cleared here — the caller deletes the old Cloudinary assets separately,
 * since this pure module performs no I/O. Positions the session on PHOTOS.
 */
export function changePhotos(session: WizardSession): WizardResult {
  session.processedUrls = [];
  session.publicIds = [];
  session.step = WizardStep.PHOTOS;
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

export function brandKeyboard(session: WizardSession): InlineKeyboard {
  const buttons = WIZARD_BRANDS.map((b, i) =>
    Markup.button.callback(b.name, buildAction('b', i)),
  );
  return withBack(session, grid(buttons, 2));
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
 * (title, part number, price) and the photo step, which previously had no
 * keyboard at all. `withBack` omits the button on a first-with-no-previous step,
 * yielding an empty keyboard (never rendered — see stepPrompt).
 */
export function backOnlyKeyboard(session: WizardSession): InlineKeyboard {
  return withBack(session, []);
}

export interface StepPrompt {
  text: string;
  keyboard?: InlineKeyboard;
}

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
    case WizardStep.TITLE:
      return {
        text: '✏️ Введите название товара.\nПример: Передний амортизатор',
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
    case WizardStep.PHOTOS:
      return {
        text: '📸 Отправьте фотографии товара — одно фото или альбом до 10 фото.',
        keyboard: backOnlyKeyboard(session),
      };
    case WizardStep.PROCESSING:
      // Transient blocking state — no Back button (previousStep returns null).
      return { text: '⏳ Пожалуйста, подождите — идёт обработка фото.' };
    case WizardStep.PHOTOS_FIRST:
      // Parallel-flow entry: photos before any question. No Back button.
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
