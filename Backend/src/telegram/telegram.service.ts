import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  DraftStatus,
  OilType,
  PackageForm,
  PartMainCategory,
  PartVehicleCategory,
  ProductKind,
  SellerStatus,
} from '@prisma/client';
import {
  DEFAULT_APP_LANG,
  localizedCategoryName,
  toAppLang,
  toBotLanguage,
  type AppLang,
} from '../common/app-lang.util';
import { Decimal } from '@prisma/client/runtime/library';
import { Context, Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { ParseOutcome } from '../ai/part-parser.types';
import { splitPartNumber } from '../ai/part-number';
import { classifyPart } from '../ai/part-classifier';
import { PrismaService } from '../prisma/prisma.service';
import { SellersService } from '../sellers/sellers.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { CatalogProjectionService } from '../catalog/projection/catalog-projection.service';
import { QueueService } from '../queue/queue.service';
import { DraftLock } from '../redis/draft-lock.service';
import { RedisKeys } from '../redis/redis.keys';
import { MediaGroupBuffer } from './media-group-buffer';
import { TelegramOfferService } from './telegram-offer.service';
import { persistVehicleLinks } from './vehicle-links';
import {
  ProductDraftService,
  isDraftFormComplete,
  type DraftWithImages,
  type QuestionnaireSnapshot,
} from './product-draft.service';
import { DraftCoordinator } from './draft-coordinator';
import { DraftTelemetry, DraftMetric } from './draft-telemetry';
import {
  DraftEvent,
  type DraftImagesFailedEvent,
  type DraftReadyForPreviewEvent,
} from './draft-events';
import {
  SellerEvent,
  type SellerApprovedEvent,
} from '../sellers/seller-events';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  WizardResult,
  WIZ_BRAND_ACTION,
  WIZ_MODEL_ACTION,
  WIZ_CATEGORY_ACTION,
  WIZ_SUBCATEGORY_ACTION,
  WIZ_PACKAGE_FORM_ACTION,
  WIZ_DESCRIPTION_SKIP,
  WIZ_PART_NUMBER_TYPE_ACTION,
  WIZ_OTHER_BRAND_ACTION,
  WIZ_OTHER_KIND_ACTION,
  WIZ_OTHER_CATEGORY_ACTION,
  WIZ_OIL_VISCOSITY_ACTION,
  WIZ_OIL_TYPE_ACTION,
  WIZ_OIL_VOLUME_ACTION,
  WIZ_ANTIFREEZE_WEIGHT_ACTION,
  WIZ_BACK_ACTION,
  WIZ_ANY_ACTION,
  isStaleCatalogPayload,
  staleCatalogMessage,
  staleCategoryMessage,
  selectBrand,
  selectOtherBrand,
  selectOtherKind,
  selectOtherCategory,
  selectModel,
  selectCategory,
  selectSubcategory,
  selectPackageForm,
  selectOilViscosity,
  inputOilViscosity,
  selectOilType,
  selectOilVolume,
  inputOilVolume,
  selectAntifreezeWeight,
  inputAntifreezeWeight,
  OTHER_KIND_BY_WIRE,
  isCategoryLevelStep,
  inputTitle,
  inputDescription,
  skipDescription,
  choosePartNumberType,
  inputPartNumber,
  inputPrice,
  beginQuestionnaire,
  goBack,
  stepPrompt,
  previewLines,
  isUniversalFor,
} from './product-wizard';
import type { CategoryOption, CategoryAnchorSelection } from './product-wizard';
import {
  ANTIFREEZE_ROOT_ID,
  CATEGORY_ID_TO_KIND,
  CategoryAnchor,
  MAIN_CATEGORY_BY_SLUG,
  VEHICLE_CATEGORY_BY_SLUG,
} from '../catalog/categories/category-map';
import {
  PartCategoryService,
  type CategoryRow,
} from '../catalog/categories/part-category.service';
import { OIL_VISCOSITIES, OIL_VOLUMES } from './motor-oil-catalog';
import { ANTIFREEZE_WEIGHTS } from './antifreeze-catalog';
import { WIZARD_CATEGORIES } from './wizard-catalog';
import {
  LANG_ACTION,
  languageKeyboard,
  t,
} from './i18n';

// Telegram delivers an album as N separate photo updates sharing a
// media_group_id, arriving back-to-back; only one carries the caption. We
// buffer by group id and flush after a short quiet window.
const MEDIA_GROUP_DEBOUNCE_MS = 1500;
const MAX_IMAGES_PER_LISTING = 10;
// A pending confirmation expires automatically after this long (10 minutes).
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
// How long a DB-backed draft lives before the cleanup sweep expires it — and,
// equivalently, the window in which /start offers to resume it. Default
// 24h (within the plan's 24–48h band): long enough that a seller returning the same
// day continues where they left off, short enough that abandoned drafts don't linger.
// Configurable via DRAFT_TTL_HOURS (see resolveDraftTtlMs); resolved once at
// construction into TelegramService.draftTtlMs.
const DRAFT_TTL_HOURS_DEFAULT = 24;
const DRAFT_TTL_HOURS_MIN = 1;
const DRAFT_TTL_HOURS_MAX = 168; // 7 days

/**
 * Resolve the draft TTL (in ms) from DRAFT_TTL_HOURS. Accepts an integer in
 * [MIN, MAX] hours; anything missing / non-integer / out of range falls back to
 * the default (logged as a warning, except when simply unset).
 */
export function resolveDraftTtlMs(
  raw: string | undefined,
  logger: Logger,
): number {
  const hourMs = 60 * 60 * 1000;
  if (raw === undefined || raw.trim() === '') {
    return DRAFT_TTL_HOURS_DEFAULT * hourMs;
  }
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < DRAFT_TTL_HOURS_MIN ||
    value > DRAFT_TTL_HOURS_MAX
  ) {
    logger.warn(
      `Invalid DRAFT_TTL_HOURS="${raw}" (expected an integer ` +
        `${DRAFT_TTL_HOURS_MIN}–${DRAFT_TTL_HOURS_MAX}); ` +
        `falling back to ${DRAFT_TTL_HOURS_DEFAULT}h.`,
    );
    return DRAFT_TTL_HOURS_DEFAULT * hourMs;
  }
  return value * hourMs;
}

// Within this window, repeated taps on stale (old-catalog) buttons by the same
// user send the "catalog updated" text message only once. The per-tap alert
// popup (answerCbQuery) still fires every time — Telegram shows it in place and
// it does not accumulate; only the chat message is deduplicated.
const STALE_NOTICE_DEDUP_MS = 5000;

// Inline-button callback payloads for the confirmation step.
const CONFIRM_ADD = 'product:add';
const CONFIRM_CANCEL = 'product:cancel';
// "⬅️ Назад" on the preview: rebuild the wizard session from the pending draft
// and return to the PRICE step. Photos are REUSED (no re-processing).
const CONFIRM_BACK = 'product:back';
// "🖼 Изменить фото" on the preview: return to the PHOTOS step and force a fresh
// upload (deletes the old assets → the pipeline re-runs on the new photos).
const CONFIRM_CHANGE_PHOTOS = 'product:change_photos';

// ── PARALLEL flow inline-button payloads ────────────────────────────────────
// /start resume prompt: continue the existing draft, or discard it and start over.
const DRAFT_RESUME = 'draft:resume';
const DRAFT_RESTART = 'draft:restart';
// Shown when image processing failed (draft.images_failed): retry only the failed
// photos, or cancel the whole draft. (Replacing photos re-uses the wizard's
// existing "start over" path, so no separate button is needed here.)
const DRAFT_RETRY_IMAGES = 'draft:retry_images';
const DRAFT_CANCEL = 'draft:cancel';

// Nudge shown to anyone interacting outside an active wizard session, in
// RUSSIAN. Kept for callers and tests that refer to the message itself; every
// send site localizes through `t(lang, 'start.hint')`.
export const START_HINT = t('ru', 'start.hint');

// Shown when a seller tries to START A NEW listing while their previous one's
// photos are still being processed. The block is lifted automatically the moment
// the batch settles, so this asks for nothing but patience.
export const IMAGES_PROCESSING_MESSAGE = t('ru', 'images.processing');

// Sent unprompted the moment an administrator approves a seller, so they learn
// their account is live without having to poll the bot with /start.
export const SELLER_APPROVED_MESSAGE = t('ru', 'seller.approved');

// Russian label for a stored PartVehicleCategory, from the wizard catalog (the
// single source of truth for these labels). Used as the preview's category line
// when the listing carries no dynamic category id to localize from.
const CATEGORY_LABELS = new Map(
  WIZARD_CATEGORIES.map((c) => [c.value, c.label]),
);

/**
 * A fully-processed listing awaiting the seller's confirmation — the in-memory
 * DELIVERY record for a preview that has been sent. Everything expensive (the
 * questionnaire, image processing/upload) is already done and durably recorded on
 * the backing ProductDraft; this only caches what the confirm/cancel/back buttons
 * need so a tap doesn't re-read the draft. The draft remains the source of truth:
 * if this record is lost (restart, TTL), /start re-presents the draft.
 */
interface PendingProduct {
  sellerId: number;
  tgUserId: number;
  metadata: ParseOutcome;
  /** Which questionnaire produced this listing — selects the preview layout and
   *  which attribute columns the commit writes. */
  kind: ProductKind;
  /** Validated non-null title (guaranteed by the wizard's TITLE step). */
  title: string;
  /** The wizard's explicit category choice — written to Product.vehicleCategory
   *  verbatim (never overridden by the keyword classifier). Null for kinds whose
   *  flow does not ask for a vehicle category (motor oils). */
  vehicleCategory: PartVehicleCategory | null;
  /** The wizard's explicit subcategory choice — written to Product.mainCategory
   *  verbatim, beating the keyword classifier's guess. Null when the chosen
   *  category has no subcategories, in which case the classifier's inference
   *  stands as before. */
  subcategory: PartMainCategory | null;
  /** The dynamic category-tree ids the seller actually chose — copied verbatim
   *  onto the Product. Authoritative; the two enum fields above are the legacy
   *  mirror kept in step with them. Null for kinds that ask no category. */
  vehicleCategoryId: string | null;
  categoryId: string | null;
  /** The sale form chosen for this listing (see PackageForm) — null when the
   *  category offered a single package code and the question was never asked. */
  packageForm: PackageForm | null;
  /** MOTOR_OIL attributes; null for every other kind. */
  oilViscosity: string | null;
  oilType: OilType | null;
  oilVolumeMl: number | null;
  /** ANTIFREEZE attribute — packaged net weight in GRAMS; null for every other
   *  kind. Kilograms are what the seller typed; grams are what is stored. */
  antifreezeWeightG: number | null;
  processedUrls: string[];
  /** Cloudinary public_ids of the uploaded preview assets, for cleanup on
   *  cancel/expiry/replacement (kept on successful confirmation). */
  publicIds: string[];
  price: Decimal;
  /** The backing draft. On confirm it is marked PUBLISHED and its STORED-ORIGINAL
   *  assets are cleaned up (the processed URLs become the product's, so they are
   *  kept). Always present — every preview comes from a draft. */
  draftId: string;
  /** The draft's `version` as observed when the preview was sent, so the edit
   *  ("⬅️ Назад") transition can take the optimistic lock without a re-read. */
  draftVersion: number;
  expiry: NodeJS.Timeout;
}

/**
 * Human-readable vehicle line for the preview caption. Universal parts say so
 * explicitly; otherwise (brand, model) pairs are grouped per brand so a
 * single-brand listing reads exactly as before ("Chevrolet Cobalt, Gentra")
 * while a cross-brand one stays unambiguous ("Chevrolet Cobalt; Hyundai Solaris").
 */
export function formatVehicleLine(
  metadata: ParseOutcome,
  lang: AppLang = DEFAULT_APP_LANG,
): string {
  if (metadata.isUniversal) return t(lang, 'preview.universalVehicle');

  if (metadata.vehicles.length > 0) {
    const byBrand = new Map<string, string[]>();
    for (const v of metadata.vehicles) {
      const key = v.brand ?? '';
      const models = byBrand.get(key) ?? [];
      models.push(v.model);
      byBrand.set(key, models);
    }
    return [...byBrand.entries()]
      .map(([brand, models]) => `${brand} ${models.join(', ')}`.trim())
      .join('; ');
  }

  // Legacy fields (no pairs detected but a bare brand may still exist).
  if (metadata.brand || metadata.models.length > 0) {
    return `${metadata.brand ?? ''} ${metadata.models.join(', ')}`.trim();
  }
  return '—';
}

/**
 * Whether a draft carries every field its kind requires. Re-exported from the
 * draft domain, which owns the SINGLE definition — the coordinator's rendezvous
 * gate and this module's preview/commit gate must always agree, and they only do
 * so by calling the same function. Kept exported here for the existing callers
 * and tests that import it from this module.
 */
export { isDraftFormComplete as isDraftComplete };

/**
 * Rebuild the wizard's conversational state from a draft, positioning the dialogue
 * at `step`. Used by /start resume and by the preview's "⬅️ Назад" edit — the draft
 * supplies every answered field, so the seller re-enters nothing. Images are NOT
 * represented here: they belong to the draft's image rows.
 */
export function buildSessionFromDraft(
  draft: {
    id: string;
    kind: ProductKind;
    brand: string | null;
    model: string | null;
    category: PartVehicleCategory | null;
    subcategory: PartMainCategory | null;
    vehicleCategoryId: string | null;
    categoryId: string | null;
    packageForm: PackageForm | null;
    title: string | null;
    description: string | null;
    partNumberType: ParseOutcome['part_number_type'];
    partNumber: string | null;
    oilViscosity: string | null;
    oilType: OilType | null;
    oilVolumeMl: number | null;
    antifreezeWeightG: number | null;
    priceUzs: Decimal | null;
  },
  step: WizardStep,
  lang: AppLang = DEFAULT_APP_LANG,
): WizardSession {
  return {
    step,
    draftId: draft.id,
    // A resumed dialogue speaks the seller's CURRENT language, not the one the
    // draft was started in: the language is a property of the person, and a
    // draft carries no copy of it to go stale.
    lang,
    kind: draft.kind,
    brand: draft.brand,
    model: draft.model,
    category: draft.category,
    subcategory: draft.subcategory,
    vehicleCategoryId: draft.vehicleCategoryId,
    categoryId: draft.categoryId,
    // Options are re-loaded when a category step is (re-)rendered, so a resumed
    // session starts with none rather than a stale snapshot of the tree.
    categoryOptions: [],
    // Nor does it remember WHICH level was last offered: a resumed dialogue
    // re-derives that from the step it is standing on (see openCategoryLevel).
    categoryOptionsParentId: null,
    // A resumed draft is past its category questions when it already has a
    // category; anything further is re-asked from the live tree.
    categoryStepPending: false,
    // The seller's answered sale form is PRESERVED across a resume/edit — the
    // category has not changed, so neither has the question's answer.
    packageForm: draft.packageForm,
    // Whether that question is on this dialogue's path is RECOMPUTED rather
    // than stored, exactly like `viscosityIsCustom`: it is true iff the seller
    // answered it (a form is stored only when asked) or is standing on it right
    // now. The category's codes are not re-read here — this module does no I/O —
    // and they do not need to be: a category that stopped offering a set code
    // only matters when the seller re-picks a category, which recomputes it.
    packageChoiceRequired:
      draft.packageForm !== null || step === WizardStep.PACKAGE_FORM,
    title: draft.title,
    description: draft.description,
    partNumberType: draft.partNumberType ?? 'UNKNOWN',
    partNumber: draft.partNumber,
    oilViscosity: draft.oilViscosity,
    oilType: draft.oilType,
    oilVolumeMl: draft.oilVolumeMl,
    // Whether the seller reached a value through the "Другое" free-text branch is
    // NOT persisted: it only shapes the back-navigation path, and a stored value
    // that isn't a preset is exactly what the custom branch produces. Recomputing
    // it from the value keeps a resumed dialogue walking back the same way it
    // walked forward, without a column whose only job is to remember a keystroke.
    viscosityIsCustom:
      draft.oilViscosity !== null &&
      !OIL_VISCOSITIES.includes(draft.oilViscosity),
    volumeIsCustom:
      draft.oilVolumeMl !== null &&
      !OIL_VOLUMES.some((v) => v.value === draft.oilVolumeMl),
    antifreezeWeightG: draft.antifreezeWeightG,
    // Same rule as the two above: recomputed from the stored value rather than
    // persisted, since a weight that is not one of the presets is exactly what
    // the free-text branch produces.
    // `!= null`, so a row read without the column (a partial select, or one
    // fetched before the migration landed) reads as "no weight" rather than as
    // a value that matches no preset and therefore looks hand-typed.
    weightIsCustom:
      draft.antifreezeWeightG != null &&
      !ANTIFREEZE_WEIGHTS.some((w) => w.value === draft.antifreezeWeightG),
    // Decimal → number: the wizard collects price as an integer sum, so the
    // draft's Decimal has no fractional part.
    price: draft.priceUzs ? draft.priceUzs.toNumber() : null,
  };
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf;

  // Draft TTL (ms), resolved once from DRAFT_TTL_HOURS.
  private readonly draftTtlMs: number;

  // Step-by-step product-creation wizard sessions, one per Telegram user.
  private readonly wizard = new WizardSessionStore();

  // Buffer for in-flight album uploads. `ctx` for the flush is captured per
  // group via the closure below (the latest ctx of the album is sufficient —
  // all updates in an album come from the same chat).
  private mediaBuffer!: MediaGroupBuffer;
  private readonly groupCtx = new Map<string, Context>();

  // One pending confirmation per Telegram user, keyed by tgUserId. Caches the
  // sent preview's data until the seller presses "Добавить товар" (the backing
  // draft is the durable record — see PendingProduct).
  private readonly pending = new Map<number, PendingProduct>();

  // Last time (ms epoch) each user was sent the "catalog updated, restart"
  // notice. Rapid repeat taps on stale buttons share one notice within
  // STALE_NOTICE_DEDUP_MS instead of piling up identical messages.
  private readonly staleNoticeSentAt = new Map<number, number>();

  // Chosen interface language per Telegram user. A pure READ CACHE in front of
  // sellers.lang (the source of truth): the bot answers dozens of updates per
  // listing and every one of them needs a language, but a language changes at
  // most a handful of times in a seller's life. Only a CHOSEN language is
  // cached — an unset one must keep reaching the DB, or a seller who picks a
  // language on another device would be stuck with the default until restart.
  private readonly langCache = new Map<number, AppLang>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sellers: SellersService,
    private readonly cloudinary: CloudinaryService,
    private readonly catalogProjection: CatalogProjectionService,
    private readonly drafts: ProductDraftService,
    private readonly draftCoordinator: DraftCoordinator,
    private readonly queue: QueueService,
    private readonly telemetry: DraftTelemetry,
    private readonly locks: DraftLock,
    // The dynamic category tree the wizard's category steps are built from.
    private readonly categories: PartCategoryService,
    // The "У меня есть" → DM offer-capture flow (isolated session state).
    private readonly offerFlow: TelegramOfferService,
  ) {
    this.draftTtlMs = resolveDraftTtlMs(
      this.config.get<string>('DRAFT_TTL_HOURS'),
      this.logger,
    );
  }

  onModuleInit() {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

    this.mediaBuffer = new MediaGroupBuffer(
      MEDIA_GROUP_DEBOUNCE_MS,
      MAX_IMAGES_PER_LISTING,
      (group) => {
        const ctx = this.groupCtx.get(String(group.tgUserId));
        this.groupCtx.delete(String(group.tgUserId));
        if (ctx)
          void this.handleWizardPhotos(ctx, group.tgUserId, group.fileIds);
      },
    );

    this.bot = new Telegraf(token);
    this.registerHandlers();

    // Only ONE process may long-poll a given bot token — Telegram 409s every
    // other getUpdates ("terminated by other getUpdates request"). A non-prod
    // instance that shares this token (staging, or a dev's laptop running the
    // backend) will otherwise kick prod off intermittently. Such instances set
    // TELEGRAM_POLLING_DISABLED=true and never poll; prod leaves it unset.
    if (this.config.get<string>('TELEGRAM_POLLING_DISABLED') === 'true') {
      this.logger.warn(
        'Bot long-polling DISABLED (TELEGRAM_POLLING_DISABLED=true) — this instance ' +
          'will NOT receive seller updates. Unset it on exactly one (prod) instance.',
      );
      return;
    }

    // launch() only resolves once polling stops (i.e. on shutdown) — log
    // start-up separately. A launch failure (e.g. a transient network error
    // reaching api.telegram.org) must not crash the whole backend as an
    // unhandled rejection; log it and leave the bot offline instead.
    this.bot
      .launch()
      .then(() => this.logger.log('Bot stopped (long polling ended)'))
      .catch((err: unknown) =>
        this.logger.error(
          `Bot launch failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        ),
      );
    this.logger.log('Bot starting (long polling)...');
  }

  onModuleDestroy() {
    this.mediaBuffer?.clear();
    this.groupCtx.clear();
    this.offerFlow.clear();
    this.wizard.clear();
    this.staleNoticeSentAt.clear();
    this.langCache.clear();
    for (const session of this.pending.values()) clearTimeout(session.expiry);
    this.pending.clear();
    this.bot?.stop('SIGTERM');
  }

  private registerHandlers() {
    // Sourcing offer-flow inline buttons (`sof:*`) — namespaced so they never
    // collide with the wizard's own actions.
    this.offerFlow.registerActions(this.bot);

    // /start: no instruction message — an ACTIVE seller goes straight into the
    // product-creation wizard (restarting any wizard already in progress).
    this.bot.start(async (ctx) => {
      const from = ctx.from;
      if (!from) return;

      // "У меня есть" deep-link (`/start offer_<ticketId>`) → the sourcing offer
      // DM flow, BEFORE any seller-wizard logic. Consumed here when it matches.
      const startPayload =
        typeof (ctx as Context & { startPayload?: string }).startPayload === 'string'
          ? (ctx as Context & { startPayload?: string }).startPayload!
          : 'text' in ctx.message
            ? ctx.message.text.split(/\s+/).slice(1).join(' ')
            : '';
      if (await this.offerFlow.startFromDeepLink(ctx, startPayload)) return;

      const seller = await this.sellers.upsertFromBot(
        BigInt(from.id),
        from.username ?? from.first_name,
      );

      // FIRST /start of a seller who has never chosen a language: ask, and stop
      // here. Everything below this point — the status messages, the wizard —
      // is written in a language, so it must not be sent before we know which.
      // The language button then re-enters this same flow (see LANG_ACTION).
      if (!seller.lang) {
        this.langCache.delete(from.id);
        await this.promptLanguage(ctx, DEFAULT_APP_LANG);
        return;
      }

      const lang = toAppLang(seller.lang);
      this.langCache.set(from.id, lang);
      await this.startForSeller(ctx, from.id, seller.id, seller.status, lang);
    });

    // Change the interface language at any time — the "settings" entry point.
    // Deliberately available in every state (mid-wizard included): the picker
    // only writes a preference, so nothing about the dialogue changes except
    // the language its next message is written in.
    this.bot.command('language', async (ctx) => {
      const from = ctx.from;
      if (!from) return;
      await this.promptLanguage(ctx, await this.resolveLang(from.id));
    });

    // A language button. Saves the choice, confirms in the NEW language, then
    // continues wherever the seller was: a first-time seller lands in the flow
    // /start would have taken them to, while one who is mid-listing simply gets
    // their current step re-prompted, translated.
    this.bot.action(LANG_ACTION, async (ctx) => {
      try {
        await ctx.answerCbQuery();
      } catch {
        // Expired callback (~15 s window) — the choice is still honoured.
      }
      const from = ctx.from;
      if (!from) return;
      const lang = (ctx.match[1] as AppLang) ?? DEFAULT_APP_LANG;

      const seller = await this.sellers.upsertFromBot(
        BigInt(from.id),
        from.username ?? from.first_name,
      );
      await this.setLang(from.id, lang);
      await this.removeInlineKeyboard(ctx);
      await ctx.reply(t(lang, 'lang.changed'));

      const session = this.wizard.get(from.id);
      if (session) {
        // Mid-dialogue: re-ask the current question in the new language rather
        // than restarting — the seller loses nothing they already answered.
        await this.sendStepPrompt(ctx, session);
        return;
      }
      await this.startForSeller(ctx, from.id, seller.id, seller.status, lang);
    });

    // Informational guide describing the wizard flow. Sends static text and
    // touches nothing in the wizard/listing pipeline (does not start a session).
    this.bot.command('help', async (ctx) => {
      const from = ctx.from;
      await ctx.reply(
        t(from ? await this.resolveLang(from.id) : DEFAULT_APP_LANG, 'help.message'),
      );
    });

    // ── Wizard button steps ─────────────────────────────────────────────────
    this.bot.action(WIZ_BRAND_ACTION, async (ctx) => {
      await this.handleWizardAction(ctx, (session) =>
        selectBrand(session, Number(ctx.match[1])),
      );
    });

    this.bot.action(WIZ_MODEL_ACTION, async (ctx) => {
      await this.handleWizardAction(ctx, (session) =>
        selectModel(session, Number(ctx.match[1])),
      );
    });

    // Category taps carry the category ID. The children of the tapped node are
    // loaded here (the wizard module itself stays pure/synchronous) and handed
    // to the transition, which uses an EMPTY list as the signal to skip the next
    // selection step entirely.
    //
    // The tapped id is re-checked against the LIVE tree first. The session's
    // option list is only a snapshot of what the keyboard rendered, so on its
    // own it would still accept a category the admin has since deactivated,
    // moved, or deleted — a stale button in an open chat. Re-reading closes that
    // window; `selectCategory` then still resolves against the rendered options,
    // so both the live state and the session's own path must agree.
    this.bot.action(WIZ_CATEGORY_ACTION, async (ctx) => {
      const categoryId = ctx.match[1];
      // The live row doubles as the FISCAL source: its package codes decide
      // whether the sale-form question follows. Read here (uncached) rather
      // than taken from the keyboard's cached option list, so the question
      // always reflects the configuration as it stands right now.
      const category = await this.selectableCategory(categoryId, null);
      if (!category) {
        await this.rejectStaleCategoryTap(ctx);
        return;
      }
      const session = ctx.from ? this.wizard.get(ctx.from.id) : undefined;
      const children = await this.loadCategoryOptions(
        categoryId,
        session?.lang ?? DEFAULT_APP_LANG,
      );
      await this.handleWizardAction(ctx, (session) =>
        selectCategory(session, categoryId, children, category),
      );
    });

    this.bot.action(WIZ_SUBCATEGORY_ACTION, async (ctx) => {
      const categoryId = ctx.match[1];
      const session = ctx.from ? this.wizard.get(ctx.from.id) : undefined;
      // A deeper pick must still hang off the LEVEL the seller is standing on,
      // so the parent is pinned to the node whose children were offered — a
      // stale keyboard from a DIFFERENT branch cannot select a foreign
      // subcategory even when the id itself is a real, active category.
      //
      // Read from `categoryOptionsParentId`, NOT from `categoryId`: the two
      // agree while walking forward, but after a "⬅️ Назад" back onto this step
      // `categoryId` holds the node the seller PICKED, and pinning the parent to
      // that would reject every option on the re-rendered keyboard as stale.
      const expectedParent = session?.categoryOptionsParentId ?? null;
      const category = await this.selectableCategory(categoryId, expectedParent);
      if (!category) {
        await this.rejectStaleCategoryTap(ctx);
        return;
      }
      const children = await this.loadCategoryOptions(
        categoryId,
        session?.lang ?? DEFAULT_APP_LANG,
      );
      await this.handleWizardAction(ctx, (session) =>
        selectSubcategory(session, categoryId, children, category),
      );
    });

    // "Штука" / "Комплект / набор" — only reachable for a category that carries
    // both package codes (the step is otherwise not in the flow).
    this.bot.action(WIZ_PACKAGE_FORM_ACTION, async (ctx) => {
      const form =
        ctx.match[1] === 'set' ? PackageForm.SET : PackageForm.SINGLE;
      await this.handleWizardAction(ctx, (session) =>
        selectPackageForm(session, form),
      );
    });

    // ── "Другое": leave the spare-parts flow and pick what is being sold ─────
    this.bot.action(WIZ_OTHER_BRAND_ACTION, async (ctx) => {
      await this.handleWizardAction(ctx, (session) =>
        selectOtherBrand(session),
      );
    });

    // "Что продаёте?" — the KIND question. Motor oil goes on to pick its
    // taxonomy from the admin-managed "Другое" menu; antifreeze has a FIXED
    // category (the existing `antifreeze` node), so that node is read from the
    // live tree here and handed to the transition — which is also where its
    // package codes come from, exactly like any other category pick.
    this.bot.action(WIZ_OTHER_KIND_ACTION, async (ctx) => {
      const kind = OTHER_KIND_BY_WIRE[ctx.match[1]];
      if (!kind) return; // shape-checked by the regex; defensive only
      const anchor =
        kind === ProductKind.ANTIFREEZE
          ? await this.loadAntifreezeAnchor()
          : null;
      await this.handleWizardAction(ctx, (session) =>
        selectOtherKind(session, kind, anchor),
      );
    });

    // A pick from the admin-managed "Другое" catalogue. Re-checked against the
    // live tree first (same guard as every other category tap), so a child the
    // admin deactivated or moved after the keyboard was sent is rejected.
    this.bot.action(WIZ_OTHER_CATEGORY_ACTION, async (ctx) => {
      const categoryId = ctx.match[1];
      const category = await this.selectableCategory(
        categoryId,
        CategoryAnchor.OTHER,
      );
      if (!category) {
        await this.rejectStaleCategoryTap(ctx);
        return;
      }
      await this.handleWizardAction(ctx, (session) =>
        selectOtherCategory(session, categoryId, category),
      );
    });

    // ── Motor-oil steps ─────────────────────────────────────────────────────
    // Viscosity and volume carry either an index or the literal "custom" (the
    // "Другое" escape hatch → a free-text step).
    this.bot.action(WIZ_OIL_VISCOSITY_ACTION, async (ctx) => {
      const choice = ctx.match[1];
      await this.handleWizardAction(ctx, (session) =>
        selectOilViscosity(
          session,
          choice === 'custom' ? 'custom' : Number(choice),
        ),
      );
    });

    this.bot.action(WIZ_OIL_TYPE_ACTION, async (ctx) => {
      await this.handleWizardAction(ctx, (session) =>
        selectOilType(session, Number(ctx.match[1])),
      );
    });

    this.bot.action(WIZ_OIL_VOLUME_ACTION, async (ctx) => {
      const choice = ctx.match[1];
      await this.handleWizardAction(ctx, (session) =>
        selectOilVolume(
          session,
          choice === 'custom' ? 'custom' : Number(choice),
        ),
      );
    });

    // ── Antifreeze step ─────────────────────────────────────────────────────
    // The packaged weight: an index into ANTIFREEZE_WEIGHTS, or "custom" for the
    // free-text (fractional kilograms) branch.
    this.bot.action(WIZ_ANTIFREEZE_WEIGHT_ACTION, async (ctx) => {
      const choice = ctx.match[1];
      await this.handleWizardAction(ctx, (session) =>
        selectAntifreezeWeight(
          session,
          choice === 'custom' ? 'custom' : Number(choice),
        ),
      );
    });

    this.bot.action(WIZ_DESCRIPTION_SKIP, async (ctx) => {
      await this.handleWizardAction(ctx, (session) => skipDescription(session));
    });

    this.bot.action(WIZ_PART_NUMBER_TYPE_ACTION, async (ctx) => {
      await this.handleWizardAction(ctx, (session) =>
        choosePartNumberType(session, ctx.match[1] as 'OEM' | 'GM' | 'SKIP'),
      );
    });

    // "⬅️ Назад": return to the previous step. Reuses the shared button handler,
    // so the tapped keyboard is stripped and the previous step's prompt is
    // re-sent. goBack only moves the step pointer — entered fields are kept, so
    // going forward again preserves everything. Registered before the catch-all
    // so a live Back tap is handled here, not treated as stale.
    this.bot.action(WIZ_BACK_ACTION, async (ctx) => {
      await this.handleWizardAction(ctx, (session) => goBack(session));
    });

    // Catch-all for wizard-shaped payloads the current-version handlers above
    // didn't consume — i.e. taps on buttons from an OUTDATED CATALOG_VERSION.
    // Registered last so it only fires after the specific matchers. Instead of
    // silently ignoring the tap, tell the seller the catalog changed and to
    // restart. `ctx.match[0]` is the full payload string.
    this.bot.action(WIZ_ANY_ACTION, async (ctx) => {
      const payload = ctx.match[0];
      if (!isStaleCatalogPayload(payload)) return; // a live payload — leave it
      await this.answerStaleCallback(ctx);
    });

    // ── Wizard text steps (title / description / part number / price) ───────
    this.bot.on(message('text'), async (ctx) => {
      const msg = ctx.message;
      const from = msg.from;
      if (!from) return;

      // An active offer session takes precedence over the product wizard.
      if (await this.offerFlow.handleText(ctx)) return;

      const session = this.wizard.get(from.id);
      if (!session) {
        await ctx.reply(t(await this.langOf(from.id), 'start.hint'));
        return;
      }

      let result: WizardResult;
      switch (session.step) {
        case WizardStep.TITLE:
          result = inputTitle(session, msg.text);
          break;
        case WizardStep.DESCRIPTION:
          result = inputDescription(session, msg.text);
          break;
        case WizardStep.PART_NUMBER:
          result = inputPartNumber(session, msg.text);
          break;
        case WizardStep.OIL_VISCOSITY_CUSTOM:
          result = inputOilViscosity(session, msg.text);
          break;
        case WizardStep.OIL_VOLUME_CUSTOM:
          result = inputOilVolume(session, msg.text);
          break;
        case WizardStep.ANTIFREEZE_WEIGHT_CUSTOM:
          result = inputAntifreezeWeight(session, msg.text);
          break;
        case WizardStep.PRICE:
          result = inputPrice(session, msg.text);
          break;
        default:
          // Button/photo steps don't take text — re-show what's expected.
          result = { status: 'stale' };
          break;
      }

      if (result.status === 'invalid') {
        await ctx.reply(result.message);
        return;
      }
      if (result.status === 'ok') {
        // Persist the answered field to the draft and, when the questionnaire is
        // finished, hand off to the coordinator (rendezvous).
        await this.handleFormAdvance(ctx, from.id, session);
        return;
      }
      // 'stale' → re-prompt the current step.
      await this.sendStepPrompt(ctx, session);
    });

    // ── Wizard photo step (last input before the preview) ───────────────────
    this.bot.on(message('photo'), async (ctx: Context) => {
      const msg = ctx.message;
      if (!msg || !('photo' in msg)) return;
      const from = msg.from;
      if (!from) return;

      // Highest-resolution rendition of this photo.
      const bestPhoto = msg.photo[msg.photo.length - 1];

      // An active offer session claims incoming photos (each appended to the
      // quote), before the wizard's album buffer sees them.
      if (await this.offerFlow.handlePhoto(ctx, bestPhoto.file_id)) return;

      const groupId = 'media_group_id' in msg ? msg.media_group_id : undefined;

      if (groupId) {
        // Buffer ALL albums (even out-of-step ones) so the flush validates the
        // wizard state exactly once per album instead of once per photo.
        this.groupCtx.set(String(from.id), ctx);
        this.mediaBuffer.add(groupId, bestPhoto.file_id, null, from.id);
        return;
      }

      // Single photo — hand over immediately.
      await this.handleWizardPhotos(ctx, from.id, [bestPhoto.file_id]);
    });

    // ── Confirmation buttons on the preview message ─────────────────────────
    this.bot.action(CONFIRM_ADD, async (ctx) => {
      await ctx.answerCbQuery();
      // Remove the keyboard first so a second tap can't re-trigger the action.
      await this.removeInlineKeyboard(ctx);
      const from = ctx.from;
      if (from) {
        await this.commitPending(ctx, from.id);
        // Terminal action: leave NO wizard state behind (the seller may have
        // started a new wizard between preview and this tap — clear it too so a
        // fresh /start is always required to begin the next listing).
        this.wizard.delete(from.id);
      }
    });

    this.bot.action(CONFIRM_CANCEL, async (ctx) => {
      await ctx.answerCbQuery();
      // Remove the keyboard first so a second tap can't re-trigger the action.
      await this.removeInlineKeyboard(ctx);
      const from = ctx.from;
      // Resolved BEFORE the dialogue is cleared, so the session's language is
      // still available and the cancel notice does not cost a DB read.
      const lang = from ? await this.resolveLang(from.id) : DEFAULT_APP_LANG;
      if (from) {
        // Terminal: delete the preview's assets, mark the backing draft CANCELLED,
        // and clear the dialogue so the flow ends fully.
        await this.cancelPendingDraft(from.id);
        this.wizard.delete(from.id);
      }
      await ctx.reply(t(lang, 'draft.addCancelled'));
    });

    // "⬅️ Назад" on the preview: reopen the DRAFT at the PRICE step to edit
    // text/price. The draft's READY images are untouched and reused, so no image
    // processing re-runs.
    this.bot.action(CONFIRM_BACK, async (ctx) => {
      await ctx.answerCbQuery();
      await this.removeInlineKeyboard(ctx);
      const from = ctx.from;
      if (from) await this.reopenDraftForEdit(ctx, from.id);
    });

    // "🖼 Изменить фото" on the preview: CLONE the draft (form fields carried over,
    // source CANCELLED, its assets deleted) and start the new one at PHOTOS_FIRST,
    // so the fresh photos go through the queue like any other upload.
    this.bot.action(CONFIRM_CHANGE_PHOTOS, async (ctx) => {
      await ctx.answerCbQuery();
      await this.removeInlineKeyboard(ctx);
      const from = ctx.from;
      if (from) await this.replaceDraftPhotos(ctx, from.id);
    });

    // ── /start resume prompt ────────────────────────────────────────────────
    this.bot.action(DRAFT_RESUME, async (ctx) => {
      await ctx.answerCbQuery();
      await this.removeInlineKeyboard(ctx);
      const from = ctx.from;
      if (from) await this.resumeDraft(ctx, from.id);
    });
    this.bot.action(DRAFT_RESTART, async (ctx) => {
      await ctx.answerCbQuery();
      await this.removeInlineKeyboard(ctx);
      const from = ctx.from;
      if (!from) return;
      const seller = await this.sellers.findByTgId(BigInt(from.id));
      const lang = toAppLang(seller?.lang);
      if (!seller || seller.status !== SellerStatus.ACTIVE) {
        await ctx.reply(t(lang, 'start.hint'));
        return;
      }
      // The prompt's keyboard may have been sent BEFORE a batch started (or a
      // re-upload began after it was rendered), so the same in-flight check runs
      // here rather than trusting the tap. Otherwise this path would cancel a
      // draft whose worker is mid-write, deleting assets from under it.
      if (await this.drafts.findImagesInFlight(seller.id)) {
        await ctx.reply(t(lang, 'images.processing'));
        return;
      }
      // Discard the old draft (assets + jobs) and begin a brand-new flow.
      await this.cancelActiveDraft(from.id);
      await this.startProductCreation(ctx, from.id, seller.id, lang);
    });

    // ── Image-failure recovery ──────────────────────────────────────────────
    this.bot.action(DRAFT_RETRY_IMAGES, async (ctx) => {
      await ctx.answerCbQuery();
      await this.removeInlineKeyboard(ctx);
      const from = ctx.from;
      if (from) await this.retryFailedImages(ctx, from.id);
    });
    this.bot.action(DRAFT_CANCEL, async (ctx) => {
      await ctx.answerCbQuery();
      await this.removeInlineKeyboard(ctx);
      const from = ctx.from;
      if (!from) return;
      const lang = await this.resolveLang(from.id);
      await this.cancelActiveDraft(from.id);
      await ctx.reply(t(lang, 'draft.createCancelled'));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Product creation: photos-first, images processed in the background via BullMQ.
  // This is the ONLY product-creation path.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Entry point for /start. If a resumable draft exists (a CREATING draft within
   * its TTL), offer to continue or start over; otherwise begin a fresh session at
   * PHOTOS_FIRST and ask for photos first.
   */
  private async startForSeller(
    ctx: Context,
    tgUserId: number,
    sellerId: number,
    status: SellerStatus,
    lang: AppLang,
  ): Promise<void> {
    if (status === SellerStatus.ACTIVE) {
      // New session: forget any prior stale-notice dedup marker so the first
      // stale tap after this restart is acknowledged in chat again.
      this.staleNoticeSentAt.delete(tgUserId);
      // A restart abandons the current dialogue position. The draft it pointed
      // at is NOT discarded here — startProductCreation offers to resume it (or,
      // if the seller chooses "start over", cancels it explicitly).
      this.wizard.delete(tgUserId);
      await this.startProductCreation(ctx, tgUserId, sellerId, lang);
      return;
    }
    if (status === SellerStatus.REJECTED) {
      await ctx.reply(t(lang, 'start.rejected'));
      return;
    }
    await ctx.reply(t(lang, 'start.pending'));
  }

  private async startProductCreation(
    ctx: Context,
    tgUserId: number,
    sellerId: number,
    lang: AppLang,
  ): Promise<void> {
    // Recovery: a draft that is READY_FOR_PREVIEW but whose preview delivery was
    // lost (crash after the coordinator flipped it, before the message was sent) is
    // invisible to the resume prompt below. Re-present it here — idempotent, and it
    // rescues the seller's fully-processed draft instead of forcing a restart.
    const awaitingPreview = await this.drafts.findAwaitingPreview(sellerId);
    if (awaitingPreview) {
      await this.presentDraftPreview(awaitingPreview.id, tgUserId);
      return;
    }

    // A draft whose image batch is still in flight BLOCKS starting a new listing.
    // Without this the seller could open a second wizard while the first draft's
    // worker jobs ran, and the preview that landed later belonged to the OLD
    // draft — arriving in the middle of the new one and reading as a bug.
    //
    // This is checked BEFORE the resume prompt on purpose: that prompt offers
    // "🆕 Начать заново", which cancels the draft and deletes assets a running
    // worker is still writing to. Refusing here means the in-flight batch is
    // never raced by a restart; once it settles the normal resume prompt (or the
    // preview) appears on the next /start, and the questionnaire continues where
    // it left off. Repeated taps are naturally idempotent — each one re-reads the
    // same rows and replies with the same message, creating nothing.
    const inFlight = await this.drafts.findImagesInFlight(sellerId);
    if (inFlight) {
      await ctx.reply(t(lang, 'images.processing'));
      // Refusing to start a new listing must not also strand THIS one. A row can
      // sit PROCESSING with no live job (the enqueue loop crashed, or the job was
      // lost), and that row is what the block keys on — so without this the draft
      // would wait behind its own "please wait" forever. Healing here keeps the
      // recovery `resumeDraft` performs reachable while the wizard stays closed:
      // re-enqueue is idempotent, so a genuinely running batch is unaffected.
      await this.reenqueueStuckImages(inFlight);
      return;
    }

    const resumable = await this.drafts.findResumable(sellerId);
    if (resumable) {
      await ctx.reply(
        t(lang, 'draft.resumePrompt'),
        Markup.inlineKeyboard([
          [
            Markup.button.callback(t(lang, 'btn.continue'), DRAFT_RESUME),
            Markup.button.callback(t(lang, 'btn.startOver'), DRAFT_RESTART),
          ],
        ]),
      );
      return;
    }
    const session = this.wizard.start(tgUserId, lang);
    await this.sendStepPrompt(ctx, session);
  }

  /**
   * Photos arrived (the PHOTOS_FIRST step). Create the DB draft with one PROCESSING
   * image row per photo, enqueue a job per row (the worker fetches + processes each
   * in the background), advance the wizard to BRAND, and start the questionnaire.
   * NO network happens here: only the tgFileId is stored — the worker fetches the
   * original itself (phase A). So the first question appears with zero upload wait.
   */
  private async handlePhotos(
    ctx: Context,
    tgUserId: number,
    session: WizardSession,
    fileIds: string[],
  ): Promise<void> {
    // Re-gate the seller (status may have changed since /start).
    const seller = await this.sellers.findByTgId(BigInt(tgUserId));
    const lang = session.lang;
    if (!seller) {
      await ctx.reply(t(lang, 'start.notRegistered'));
      return;
    }
    if (seller.status === SellerStatus.PENDING) {
      await ctx.reply(t(lang, 'start.awaitingApproval'));
      return;
    }
    if (seller.status === SellerStatus.REJECTED) {
      await ctx.reply(t(lang, 'start.accountRejected'));
      return;
    }

    const images = fileIds.slice(0, MAX_IMAGES_PER_LISTING);
    if (images.length === 0) {
      await this.sendStepPrompt(ctx, session);
      return;
    }

    // Advance the FSM first so a second album racing the first is a stale no-op.
    if (beginQuestionnaire(session).status !== 'ok') return;

    let draft: DraftWithImages;
    try {
      draft = await this.drafts.createWithImages({
        sellerId: seller.id,
        tgId: BigInt(tgUserId),
        formStep: session.step, // BRAND
        expiresAt: new Date(Date.now() + this.draftTtlMs),
        images: images.map((fileId, i) => ({ sortOrder: i, tgFileId: fileId })),
      });
    } catch (err) {
      this.logger.error(
        `Failed to create draft for ${tgUserId}: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      // Roll the FSM back so the seller can retry the upload.
      session.step = WizardStep.PHOTOS_FIRST;
      await ctx.reply(t(lang, 'photos.notAccepted'));
      return;
    }

    session.draftId = draft.id;
    this.telemetry.event('draft.created', {
      draftId: draft.id,
      sellerId: seller.id,
    });
    this.telemetry.metric(DraftMetric.DRAFT_CREATED, {
      draftId: draft.id,
      sellerId: seller.id,
    });

    // Enqueue one job per image row (locked + deterministic jobId → idempotent).
    for (const img of draft.images) {
      try {
        const jobId = await this.enqueueImageJob(draft.id, img.id);
        if (jobId === null) continue; // a concurrent enqueue already covers this row
        this.telemetry.event('image.queued', {
          draftId: draft.id,
          imageId: img.id,
          sellerId: seller.id,
          jobId,
        });
        this.telemetry.metric(DraftMetric.IMAGE_QUEUED, {
          draftId: draft.id,
          imageId: img.id,
          jobId,
        });
      } catch (err) {
        this.logger.error(
          `Failed to enqueue image ${img.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await ctx.reply(t(lang, 'photos.received', { count: images.length }));
    // Start the questionnaire immediately (images process in parallel).
    await this.sendStepPrompt(ctx, session);
  }

  /**
   * A questionnaire step was answered. Persist the answered fields to the draft (so
   * nothing is lost on restart/expiry), then either continue the questionnaire or,
   * once it is finished (QUESTIONNAIRE_DONE), hand off to the coordinator. If the
   * images are already done the coordinator sends the preview immediately (its
   * ready_for_preview event); otherwise the seller sees a short holding message and
   * the preview follows automatically when the last image lands.
   */
  private async handleFormAdvance(
    ctx: Context,
    tgUserId: number,
    session: WizardSession,
  ): Promise<void> {
    if (!session.draftId) {
      // Defensive: a session must have a draft by the time the questionnaire runs
      // (photos precede every question). If not, restart cleanly.
      this.logger.error(
        `Wizard session for ${tgUserId} has no draftId — restarting.`,
      );
      const lang = session.lang;
      this.wizard.delete(tgUserId);
      await ctx.reply(t(lang, 'start.hint'));
      return;
    }

    // Persist the current field snapshot (idempotent; cheap). Typed as
    // QuestionnaireSnapshot, NOT the looser DraftFormPatch: that type demands
    // every field some kind requires, so a new kind cannot be added without its
    // attribute being saved here.
    const snapshot: QuestionnaireSnapshot = {
      formStep: session.step,
      kind: session.kind,
      brand: session.brand,
      model: session.model,
      category: session.category,
      subcategory: session.subcategory,
      vehicleCategoryId: session.vehicleCategoryId,
      categoryId: session.categoryId,
      packageForm: session.packageForm,
      title: session.title,
      description: session.description,
      partNumberType: session.partNumberType,
      partNumber: session.partNumber,
      oilViscosity: session.oilViscosity,
      oilType: session.oilType,
      oilVolumeMl: session.oilVolumeMl,
      // ANTIFREEZE's ONLY required field. Omitting it here (while every other
      // kind's attributes were listed) is what stranded antifreeze sellers on
      // "⏳ Завершаем обработку фото…": the session held the weight, but
      // `updateForm` never wrote it, so the column stayed NULL and
      // isDraftFormComplete failed the rendezvous forever — no matter how many
      // images went READY. Every field of DraftFormPatch is optional and Prisma
      // reads `undefined` as "leave alone", so nothing caught the omission.
      antifreezeWeightG: session.antifreezeWeightG,
      priceUzs: session.price ?? undefined,
    };
    await this.drafts.updateForm(session.draftId, snapshot);

    if (session.step !== WizardStep.QUESTIONNAIRE_DONE) {
      // More questions to go.
      await this.sendStepPrompt(ctx, session);
      return;
    }

    // Questionnaire finished: the wizard session is consumed — the coordinator /
    // pending machinery owns the flow now, and the draft's own TTL governs from here.
    this.wizard.deleteIf(tgUserId, session);

    // Ask the coordinator to evaluate the rendezvous. If images are all READY it
    // emits ready_for_preview (→ our @OnEvent sends the preview). If not, tell the
    // seller we're finishing the photos; the worker's completion will trigger it.
    const draftId = session.draftId;
    await this.draftCoordinator.onFormStep(draftId);
    const draft = await this.drafts.findWithImages(draftId);
    if (draft && draft.status === 'CREATING') {
      // Still waiting on images (or one failed — the images_failed event handles
      // that case with its own message). Only show the holding text if nothing has
      // failed yet, to avoid contradicting the failure notice.
      const anyFailed = draft.images.some((img) => img.status === 'FAILED');
      if (!anyFailed) {
        await ctx.reply(t(session.lang, 'photos.finishing'));
      }
    }
  }

  // ── Domain-event listeners (the worker↔bot seam) ────────────────────────────
  /**
   * Both tracks finished (form complete + all images READY): the coordinator flipped
   * the draft to READY_FOR_PREVIEW and emitted this. Build the pending confirmation
   * from the draft and send the preview to the seller's chat (there may be no live
   * ctx — the images may have finished after the form). The confirm/cancel/back
   * buttons then reuse the EXISTING pending machinery unchanged.
   */
  @OnEvent(DraftEvent.READY_FOR_PREVIEW)
  async onDraftReadyForPreview(
    event: DraftReadyForPreviewEvent,
  ): Promise<void> {
    try {
      await this.presentDraftPreview(event.draftId, Number(event.tgId));
    } catch (err) {
      this.logger.error(
        `Failed to present preview for draft ${event.draftId}: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  /**
   * An administrator approved a seller: tell them straight away, in their chat,
   * without waiting for them to send anything. The bot is the only place the
   * seller has an identity we can reach (tgId IS the chat id), which is why this
   * lives here rather than in the admin module.
   *
   * Delivery is BEST-EFFORT by contract: the approval has already been committed
   * by the emitter, so every failure mode here — the seller blocked the bot, never
   * opened a chat with it, Telegram is down, the bot has not launched — is logged
   * and swallowed. Nothing in this method can undo or fail the approval. The
   * seller still learns they are active the next time they send /start, which is
   * exactly the behaviour that existed before this notification.
   */
  @OnEvent(SellerEvent.APPROVED)
  async onSellerApproved(event: SellerApprovedEvent): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(
        Number(event.tgId),
        t(await this.langOf(Number(event.tgId)), 'seller.approved'),
      );
    } catch (err) {
      this.logger.error(
        `Failed to notify seller #${event.sellerId} of approval: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * At least one image failed after retries (draft stays CREATING, form data kept).
   * Offer the seller retry (re-enqueue only the failed photos) or cancel. Replacing
   * photos is done by starting over (/start), so no separate button is needed.
   */
  @OnEvent(DraftEvent.IMAGES_FAILED)
  async onDraftImagesFailed(event: DraftImagesFailedEvent): Promise<void> {
    try {
      const tgUserId = Number(event.tgId);
      const lang = await this.resolveLang(tgUserId);
      await this.bot.telegram.sendMessage(
        tgUserId,
        t(lang, 'draft.imagesFailed', { count: event.failedCount }),
        Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.retry'), DRAFT_RETRY_IMAGES)],
          [Markup.button.callback(t(lang, 'btn.cancel'), DRAFT_CANCEL)],
        ]),
      );
    } catch (err) {
      this.logger.error(
        `Failed to notify image failure for draft ${event.draftId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Build the pending confirmation from a READY_FOR_PREVIEW draft and send the
   * preview. Idempotent: a draft not in READY_FOR_PREVIEW (already presented,
   * cancelled, published, expired) is skipped.
   */
  private async presentDraftPreview(
    draftId: string,
    chatId: number,
  ): Promise<void> {
    // Dedup the two legitimate candidates (the coordinator's ready_for_preview
    // event and a /start recovery) BEFORE they both read the draft and race on
    // the claim. `claimPreviewSend` remains the authority — it is the only thing
    // that decides who sends — so a lock that is unavailable, expired or failed
    // open changes nothing: the loser of the CAS still bails without sending.
    await this.locks.withLock(RedisKeys.lockDraftPreview(draftId), () =>
      this.deliverDraftPreview(draftId, chatId),
    );
  }

  /** The guarded body of {@link presentDraftPreview}; see the locking note there. */
  private async deliverDraftPreview(
    draftId: string,
    chatId: number,
  ): Promise<void> {
    const draft = await this.drafts.findWithImages(draftId);
    if (!draft || draft.status !== 'READY_FOR_PREVIEW') return;

    const processedUrls = draft.images
      .filter((img) => img.status === 'READY' && img.processedUrl)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((img) => img.processedUrl as string);
    const publicIds = draft.images
      .filter((img) => img.processedPublicId)
      .map((img) => img.processedPublicId as string);

    if (processedUrls.length === 0 || !isDraftFormComplete(draft)) {
      this.logger.error(
        `Draft ${draftId} reached preview with incomplete data — skipping.`,
      );
      return;
    }

    // Atomically claim the right to send. Two candidates (the worker's
    // ready-for-preview event and a /start recovery) can both reach here in
    // READY_FOR_PREVIEW; only the one that flips previewSentAt (count === 1) sends,
    // so storePending never runs twice for the same draft (which would delete the
    // first preview's Cloudinary assets). The loser simply bails.
    const claimed = await this.drafts.claimPreviewSend(draftId);
    if (!claimed) return;

    const pending = this.buildPendingFromDraft(draft, chatId, {
      processedUrls,
      publicIds,
      // claimPreviewSend incremented the version, so the row is now at read+1.
      // The "⬅️ Назад" edit uses this to take the optimistic lock without a re-read.
      draftVersion: draft.version + 1,
    });

    this.storePending(pending);
    await this.sendPreviewToChat(chatId, pending, processedUrls);
  }

  /**
   * Assemble the confirmation record for a draft that has already been checked
   * COMPLETE for its kind ({@link isDraftComplete}). Shared by the first preview
   * send and by {@link rebuildPendingFromDraft}, so the two can never derive a
   * different record from the same row — the reason a rebuilt pending is as good
   * as the original.
   *
   * The non-null assertions on title/priceUzs are discharged by the caller's
   * completeness check; every kind requires both, so no flow can reach here
   * without them.
   */
  private buildPendingFromDraft(
    draft: DraftWithImages,
    tgUserId: number,
    delivery: {
      processedUrls: string[];
      publicIds: string[];
      draftVersion: number;
    },
  ): Omit<PendingProduct, 'expiry'> {
    return {
      sellerId: draft.sellerId,
      tgUserId,
      metadata: this.buildMetadataFromDraft(draft),
      kind: draft.kind,
      title: draft.title as string,
      vehicleCategory: draft.category,
      subcategory: draft.subcategory,
      vehicleCategoryId: draft.vehicleCategoryId,
      categoryId: draft.categoryId,
      packageForm: draft.packageForm,
      oilViscosity: draft.oilViscosity,
      oilType: draft.oilType,
      oilVolumeMl: draft.oilVolumeMl,
      antifreezeWeightG: draft.antifreezeWeightG,
      processedUrls: delivery.processedUrls,
      publicIds: delivery.publicIds,
      price: new Decimal(draft.priceUzs as Decimal),
      draftId: draft.id,
      draftVersion: delivery.draftVersion,
    };
  }

  /**
   * PARALLEL flow — finalize a draft after its product was committed: mark it
   * PUBLISHED and delete the intermediate ORIGINAL Cloudinary assets (processed
   * assets are the product's now and are kept). All best-effort — the product is
   * already saved, so nothing here is allowed to surface as an error.
   */
  private async finalizePublishedDraft(
    draftId: string,
    sellerId: number,
  ): Promise<void> {
    try {
      const published = await this.drafts.publishDraft(draftId);
      const originalIds = await this.drafts.collectOriginalPublicIds(draftId);
      if (originalIds.length > 0) {
        await this.cloudinary.deleteAssets(originalIds);
      }
      if (published) {
        this.telemetry.event('draft.published', { draftId, sellerId });
        this.telemetry.metric(DraftMetric.DRAFT_PUBLISHED, {
          draftId,
          sellerId,
        });
      }
    } catch (err) {
      this.logger.error(
        `Failed to finalize published draft ${draftId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Map a draft's collected fields into the ParseOutcome the preview/commit use.
   *
   * A draft with NO vehicle (every non-spare-part kind — its questionnaire never
   * asks for one) yields EMPTY vehicles/models rather than a `{brand: '', model:
   * ''}` placeholder. That matters beyond cosmetics: `persistVehicleLinks` walks
   * `vehicles` to create brand/car_model rows, so a blank pair would mint junk
   * catalog entries.
   *
   * `isUniversal` is DERIVED FROM THE LISTING'S OWN VEHICLE, never asked: a
   * listing that named a brand+model is specific to it, and one that named none
   * fits everything. It is NOT derived from the kind — a motor oil sold FOR a
   * Chevrolet Cobalt is vehicle-specific, while an oil listed under "Другое"
   * (where no vehicle is ever collected) is universal, and both are MOTOR_OIL.
   *
   * Deriving it here — rather than at the product write — is what makes the rule
   * hold everywhere at once, because this one value is what the preview line, the
   * Product column and `persistVehicleLinks` all read. Universal + empty vehicles
   * is exactly the combination that means "fits everything, so no per-vehicle
   * links": see vehicle-links.ts, which returns before creating any row.
   */
  private buildMetadataFromDraft(draft: {
    kind: ProductKind;
    brand: string | null;
    model: string | null;
    title: string | null;
    description: string | null;
    partNumber: string | null;
    partNumberType: ParseOutcome['part_number_type'];
    priceUzs: Decimal | null;
  }): ParseOutcome {
    const hasVehicle = draft.brand !== null && draft.model !== null;
    return {
      title: draft.title ?? '',
      description: draft.description,
      brand: draft.brand,
      models: hasVehicle ? [draft.model as string] : [],
      vehicles: hasVehicle
        ? [{ brand: draft.brand, model: draft.model as string }]
        : [],
      isUniversal: isUniversalFor(draft.kind, {
        brand: draft.brand,
        model: draft.model,
      }),
      gm_number: draft.partNumber,
      part_number_type: draft.partNumberType,
      price: draft.priceUzs ? draft.priceUzs.toNumber() : 0,
      source: 'wizard',
      confidence: 1,
    };
  }

  /**
   * Resume the seller's in-progress draft on /start. Restore the dialogue at the
   * draft's saved formStep, then re-prompt. Images keep processing in the background
   * (their jobs are still queued), so the rendezvous will fire normally. If the form
   * was already finished, nudge to wait / re-check.
   */
  private async resumeDraft(ctx: Context, tgUserId: number): Promise<void> {
    const seller = await this.sellers.findByTgId(BigInt(tgUserId));
    const lang = toAppLang(seller?.lang);
    if (!seller || seller.status !== SellerStatus.ACTIVE) {
      await ctx.reply(t(lang, 'start.hint'));
      return;
    }
    const draft = await this.drafts.findResumable(seller.id);
    if (!draft) {
      await ctx.reply(t(lang, 'draft.expired'));
      return;
    }

    // Rebuild the dialogue from the draft's saved state (the single source of truth).
    const session = buildSessionFromDraft(
      draft,
      (draft.formStep as WizardStep) ?? WizardStep.BRAND,
      lang,
    );
    this.wizard.restore(tgUserId, session);

    // Recovery: re-enqueue any image still PROCESSING without a result. This heals
    // rows that were created but whose job never made it into the queue (a crash in
    // the original enqueue loop) or was lost — otherwise they would sit PROCESSING
    // forever and the rendezvous would never fire. reenqueueImage is idempotent: a
    // still-running/queued job is left effectively as-is; a genuinely stuck row gets
    // a fresh job. Rows that already succeeded (processedUrl set) are untouched.
    await this.reenqueueStuckImages(draft);

    const anyFailed = draft.images.some((img) => img.status === 'FAILED');
    if (anyFailed) {
      await this.bot.telegram.sendMessage(
        tgUserId,
        t(lang, 'draft.imagesPartiallyFailed'),
        Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'btn.retry'), DRAFT_RETRY_IMAGES)],
          [Markup.button.callback(t(lang, 'btn.cancel'), DRAFT_CANCEL)],
        ]),
      );
      return;
    }
    if (session.step === WizardStep.QUESTIONNAIRE_DONE) {
      // Form already complete — either images are still going or just finished.
      await this.draftCoordinator.onFormStep(draft.id);
      await ctx.reply(t(lang, 'photos.finishing'));
      return;
    }
    await ctx.reply(t(lang, 'draft.resumed'));
    await this.sendStepPrompt(ctx, session);
  }

  /**
   * Re-enqueue any image row that is still PROCESSING but has no processed result —
   * i.e. its job never ran or was lost (enqueue-loop crash, worker gone, etc.). Uses
   * reenqueueImage so a job still in the queue is not duplicated while a genuinely
   * stuck row gets a fresh job. Best-effort per row; a failure to enqueue one row is
   * logged and does not block the others.
   */
  private async reenqueueStuckImages(draft: DraftWithImages): Promise<void> {
    const stuck = draft.images.filter(
      (img) => img.status === 'PROCESSING' && !img.processedUrl,
    );
    for (const img of stuck) {
      try {
        await this.enqueueImageJob(draft.id, img.id, 'reenqueue');
      } catch (err) {
        this.logger.error(
          `Failed to re-enqueue stuck image ${img.id} (draft ${draft.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * PARALLEL flow — retry the failed images of the seller's draft: reset the FAILED
   * rows to PROCESSING and re-enqueue only those. Keeps all form data. If nothing is
   * failed (e.g. a stale tap), report gently.
   */
  private async retryFailedImages(
    ctx: Context,
    tgUserId: number,
  ): Promise<void> {
    const seller = await this.sellers.findByTgId(BigInt(tgUserId));
    const lang = toAppLang(seller?.lang);
    if (!seller) {
      await ctx.reply(t(lang, 'start.hint'));
      return;
    }
    const draft = await this.drafts.findResumable(seller.id);
    if (!draft) {
      await ctx.reply(t(lang, 'draft.expired'));
      return;
    }
    const reset = await this.drafts.resetFailedImages(draft.id);
    const toReenqueue = reset.filter(
      (img) => img.status === 'PROCESSING' && !img.processedUrl,
    );
    if (toReenqueue.length === 0) {
      await ctx.reply(t(lang, 'photos.noneToRetry'));
      return;
    }
    for (const img of toReenqueue) {
      try {
        // 'reenqueue' (not 'enqueue'): the previous FAILED job is still in Redis
        // under the same deterministic id, so a plain add() would be a no-op.
        await this.enqueueImageJob(draft.id, img.id, 'reenqueue');
      } catch (err) {
        this.logger.error(
          `Failed to re-enqueue image ${img.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await ctx.reply(t(lang, 'photos.retrying'));
  }

  /**
   * Cancel the seller's in-progress (CREATING) draft: delete its Cloudinary assets,
   * remove any unfinished image jobs, and mark it CANCELLED (versioned, so a
   * concurrent transition is respected). Also clears the dialogue.
   */
  private async cancelActiveDraft(tgUserId: number): Promise<void> {
    this.wizard.delete(tgUserId);
    const seller = await this.sellers.findByTgId(BigInt(tgUserId));
    if (!seller) return;
    const draft = await this.drafts.findResumable(seller.id);
    if (!draft) return;

    await this.discardDraftAssets(draft);
    await this.drafts.tryTransition(
      draft.id,
      DraftStatus.CREATING,
      DraftStatus.CANCELLED,
      draft.version,
    );
  }

  /**
   * "❌ Отменить" on the preview: drop the pending record, delete the preview's
   * Cloudinary assets, and mark the backing READY_FOR_PREVIEW draft CANCELLED so the
   * sweep has nothing left to do. Best-effort on the draft side — the seller's cancel
   * must always be acknowledged.
   *
   * The DB transition must NOT depend on the in-memory `pending` record. That record
   * is process-local and evicted after CONFIRMATION_TTL_MS, so a cancel tapped late
   * (or after a restart/redeploy) used to return here before writing anything: the
   * draft stayed READY_FOR_PREVIEW and the next /start re-presented the very preview
   * the seller had just cancelled. When `pending` is gone we resolve the draft from
   * the DB instead — the same lookup /start recovery uses — so cancel is always
   * terminal.
   */
  private async cancelPendingDraft(tgUserId: number): Promise<void> {
    const pending =
      this.takePending(tgUserId) ??
      (await this.rebuildPendingFromDraft(tgUserId));
    if (!pending) return;
    if (pending.publicIds.length > 0) {
      await this.cloudinary.deleteAssets(pending.publicIds);
    }
    try {
      const draft = await this.drafts.findWithImages(pending.draftId);
      if (!draft || draft.status !== DraftStatus.READY_FOR_PREVIEW) return;
      // Remove the originals too (the processed ids came from `pending`).
      const originals = await this.drafts.collectOriginalPublicIds(draft.id);
      if (originals.length > 0) await this.cloudinary.deleteAssets(originals);
      await this.drafts.tryTransition(
        draft.id,
        DraftStatus.READY_FOR_PREVIEW,
        DraftStatus.CANCELLED,
        draft.version,
      );
    } catch (err) {
      this.logger.error(
        `Failed to cancel draft for tg user ${tgUserId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The seller's READY_FOR_PREVIEW draft, resolved from the DB — the fallback used
   * when the in-memory pending record is gone (TTL eviction or a restart).
   */
  private async resolveAwaitingPreviewDraft(
    tgUserId: number,
  ): Promise<DraftWithImages | null> {
    const seller = await this.sellers.findByTgId(BigInt(tgUserId));
    if (!seller) return null;
    return this.drafts.findAwaitingPreview(seller.id);
  }

  /**
   * Rebuild a pending confirmation from the DB for a seller whose in-memory record
   * is gone. The `pending` map is a UX cache, never the source of truth: every field
   * below is derived from the draft exactly as {@link deliverDraftPreview} derives it
   * when the preview is first sent, so a cache miss costs a query — never a lost
   * state transition. Returns null when the seller has no draft awaiting a preview,
   * or when that draft is missing the data a preview requires.
   *
   * The returned record is NOT inserted into `pending` (there is no live preview
   * message to own it) and carries no `expiry` timer — callers consume it directly.
   */
  private async rebuildPendingFromDraft(
    tgUserId: number,
  ): Promise<Omit<PendingProduct, 'expiry'> | null> {
    const draft = await this.resolveAwaitingPreviewDraft(tgUserId);
    if (!draft) return null;

    const processedUrls = draft.images
      .filter((img) => img.status === 'READY' && img.processedUrl)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((img) => img.processedUrl as string);
    const publicIds = draft.images
      .filter((img) => img.processedPublicId)
      .map((img) => img.processedPublicId as string);

    if (processedUrls.length === 0 || !isDraftFormComplete(draft)) {
      this.logger.error(
        `Draft ${draft.id} cannot be rebuilt for confirmation — incomplete data.`,
      );
      return null;
    }

    return this.buildPendingFromDraft(draft, tgUserId, {
      processedUrls,
      publicIds,
      // The row's CURRENT version — the preview send already bumped it, so this is
      // the value an optimistic transition must present.
      draftVersion: draft.version,
    });
  }

  /**
   * "⬅️ Назад" on the preview — edit text/price. Moves the backing draft from
   * READY_FOR_PREVIEW back to CREATING (versioned) and restores the dialogue at the
   * PRICE step. The draft's images stay READY and their assets are UNTOUCHED, so
   * re-submitting the form rebuilds the preview with NO image re-processing: the
   * coordinator's rendezvous simply passes again on the image axis.
   *
   * A missing pending record falls back to the DB (the cache is not the source of
   * truth); only a draft that has genuinely moved on is reported and left alone.
   */
  private async reopenDraftForEdit(
    ctx: Context,
    tgUserId: number,
  ): Promise<void> {
    const lang = await this.langOf(tgUserId);
    const pending =
      this.takePending(tgUserId) ??
      (await this.rebuildPendingFromDraft(tgUserId));
    if (!pending) {
      await ctx.reply(t(lang, 'edit.noProduct'));
      return;
    }

    // Serialize double-taps on Back. `reopenForEdit` is already versioned (and
    // already resets previewSentAt so the next rendezvous may send a fresh
    // preview), so this only saves the loser a wasted round-trip. Note what is
    // deliberately ABSENT from this whole path: no enqueueImage, no
    // reenqueueImage, no coordinator call. Back reuses the draft's READY images
    // as-is, so it must never create image jobs — the lock does not change that,
    // and neither does losing it.
    const reopened = await this.locks.withLock(
      RedisKeys.lockDraftReopen(pending.draftId),
      () =>
        this.drafts.reopenForEdit(
          pending.draftId,
          pending.draftVersion,
          WizardStep.PRICE,
        ),
    );
    if (!reopened) {
      // The draft was published/cancelled/expired, or a double-tap won the race.
      await ctx.reply(t(lang, 'edit.notEditable'));
      return;
    }

    const draft = await this.drafts.findWithImages(pending.draftId);
    if (!draft) {
      await ctx.reply(t(lang, 'edit.notEditable'));
      return;
    }
    const session = buildSessionFromDraft(draft, WizardStep.PRICE, lang);
    this.wizard.restore(tgUserId, session);
    await this.sendStepPrompt(ctx, session);
  }

  /**
   * "🖼 Изменить фото" on the preview — replace the photos. Modelled as "a NEW draft
   * based on the existing one" rather than as mutating the current draft: the source
   * already owns READY images, Cloudinary assets and possibly in-flight jobs, so
   * clearing and reusing it would race the worker and the coordinator.
   *
   *   source draft → CANCELLED (+ its assets and jobs removed)
   *   new draft    → CREATING at PHOTOS_FIRST, every answered form field copied
   *
   * The seller then uploads photos exactly like a first-time listing, so the fresh
   * images travel the ONE pipeline (Telegram → BullMQ → worker → coordinator →
   * preview) and retypes nothing.
   */
  private async replaceDraftPhotos(
    ctx: Context,
    tgUserId: number,
  ): Promise<void> {
    const lang = await this.langOf(tgUserId);
    const pending =
      this.takePending(tgUserId) ??
      (await this.rebuildPendingFromDraft(tgUserId));
    if (!pending) {
      await ctx.reply(t(lang, 'edit.noProduct'));
      return;
    }

    // Lock the SOURCE draft for the whole read → clone → discard sequence. Two
    // rapid taps would otherwise both read READY_FOR_PREVIEW and both walk the
    // Cloudinary/queue teardown; the transaction still lets only one of them
    // cancel the source (the loser's clone returns null), but the loser would
    // have already spent the I/O. The lock collapses it up front. Redis being
    // down only costs us that saving — the transaction below is unchanged.
    const clone = await this.locks.withLock(
      RedisKeys.lockDraftClone(pending.draftId),
      async () => {
        const source = await this.drafts.findWithImages(pending.draftId);
        if (!source || source.status !== DraftStatus.READY_FOR_PREVIEW) {
          return null;
        }

        // Collect the source's asset ids BEFORE it is cancelled (rows go with it).
        const publicIds = await this.drafts.collectPublicIds(source.id);

        const created = await this.drafts.cloneForPhotoReplacement({
          sourceId: source.id,
          expectedStatus: DraftStatus.READY_FOR_PREVIEW,
          expiresAt: new Date(Date.now() + this.draftTtlMs),
          formStep: WizardStep.PHOTOS_FIRST,
        });
        // Lost the race (published/cancelled/swept meanwhile) — leave everything
        // as is. Critically, the assets are NOT touched: the clone did not
        // commit, so the source still owns and needs them.
        if (!created) return null;

        // COMMITTED. Only now are the source's assets and leftover jobs ours to
        // drop — asset deletion stays strictly after a successful clone.
        await this.discardDraftJobs(source);
        if (publicIds.length > 0) await this.cloudinary.deleteAssets(publicIds);
        return created;
      },
    );

    if (!clone) {
      // Either the DB rejected it, or a concurrent tap holds the lock (undefined).
      await ctx.reply(t(lang, 'edit.notEditable'));
      return;
    }

    // Open the dialogue on the clone at PHOTOS_FIRST: the next album creates its
    // image rows and enqueues them like any first upload.
    const session = buildSessionFromDraft(clone, WizardStep.PHOTOS_FIRST, lang);
    this.wizard.restore(tgUserId, session);
    await ctx.reply(t(lang, 'photos.sendNew'));
    await this.sendStepPrompt(ctx, session);
  }

  /**
   * Delete every Cloudinary asset a draft owns and remove its unfinished image jobs.
   * Used when a draft becomes terminal by seller action (cancel / restart).
   */
  private async discardDraftAssets(draft: DraftWithImages): Promise<void> {
    const publicIds = await this.drafts.collectPublicIds(draft.id);
    if (publicIds.length > 0) await this.cloudinary.deleteAssets(publicIds);
    await this.discardDraftJobs(draft);
  }

  /**
   * The single guarded entry point for putting an image row on the queue. Every
   * enqueue path (first upload, stuck-row recovery, failed-image retry) goes
   * through here so the guard cannot be forgotten at a new call site.
   *
   * Two layers, in this order:
   *   1. Redis lock on (draftId, imageId), held for `DraftLock.ENQUEUE_TTL_SECONDS`
   *      (short — see that constant) — collapses a burst (an impatient double-tap
   *      on "🔁 Повторить", or a /start recovery overlapping a retry) before it
   *      reaches BullMQ at all.
   *   2. The deterministic jobId in QueueService — the real guarantee, which
   *      still holds when Redis is down or the lock has expired.
   * The lock is therefore load-shedding, not correctness. The short TTL matters
   * specifically for retries: a crashed holder must stop shadowing this key fast,
   * because the next legitimate call is often `resetFailedImages` (DB) immediately
   * followed by a 'reenqueue' here — the lock must not be the reason that stalls.
   *
   * `mode` picks the BullMQ semantics the caller needs: 'enqueue' for a fresh
   * row, 'reenqueue' for retry/recovery (removes the retained FAILED job first,
   * since a plain add() under the same id would silently no-op).
   *
   * Returns the enqueued job's id (possibly undefined if BullMQ gave none), or
   * null when the enqueue was SKIPPED as a duplicate — a skip is not an error,
   * so callers use `=== null` to tell "someone else has this" from "queued".
   */
  private async enqueueImageJob(
    draftId: string,
    imageId: string,
    mode: 'enqueue' | 'reenqueue' = 'enqueue',
  ): Promise<string | undefined | null> {
    const enqueued = await this.locks.withLock(
      RedisKeys.lockDraftImageEnqueue(draftId, imageId),
      // Wrapped in an object so "lock busy" (withLock → undefined) stays
      // distinguishable from "enqueued a job that reported no id".
      async () => {
        const job =
          mode === 'reenqueue'
            ? await this.queue.reenqueueImage({ draftId, imageId })
            : await this.queue.enqueueImage({ draftId, imageId });
        if (job.id) await this.drafts.setImageJobId(imageId, job.id);
        return { jobId: job.id };
      },
      // ENQUEUE_TTL, not the 30s default: this critical section is a couple of
      // BullMQ calls (no external I/O), and a short TTL bounds how long a
      // crashed holder can shadow a legitimate reenqueue — see the constant's
      // doc for the retry-after-crash scenario this specifically guards against.
      { ttlSeconds: DraftLock.ENQUEUE_TTL_SECONDS },
    );
    if (!enqueued) {
      // Undefined only when a concurrent enqueue for this exact row holds the
      // lock — that job covers this request, so skipping is the correct outcome.
      this.logger.debug(
        `Skipped duplicate enqueue for image ${imageId} (draft ${draftId})`,
      );
      return null;
    }
    return enqueued.jobId;
  }

  /** Best-effort removal of a draft's queued image jobs (already-gone/active is fine). */
  private async discardDraftJobs(draft: DraftWithImages): Promise<void> {
    for (const img of draft.images) {
      if (!img.jobId) continue;
      try {
        await this.queue.removeImageJob(img.jobId);
      } catch {
        // already gone / active — ignore.
      }
    }
  }

  // ── Wizard plumbing ─────────────────────────────────────────────────────────
  // ── Interface language ────────────────────────────────────────────────────
  /**
   * The seller's chosen language, or the default when they have not chosen one.
   *
   * Reads the cache first, then `sellers.lang`. A DB failure falls back to the
   * default instead of throwing: a handler that cannot determine a language
   * must still answer the seller, in *some* language.
   */
  private async langOf(tgUserId: number): Promise<AppLang> {
    const cached = this.langCache.get(tgUserId);
    if (cached) return cached;
    try {
      const seller = await this.sellers.findByTgId(BigInt(tgUserId));
      if (!seller?.lang) return DEFAULT_APP_LANG;
      const lang = toAppLang(seller.lang);
      this.langCache.set(tgUserId, lang);
      return lang;
    } catch (err) {
      this.logger.warn(
        `Could not read language for ${tgUserId}: ${
          err instanceof Error ? err.message : String(err)
        } — using ${DEFAULT_APP_LANG}.`,
      );
      return DEFAULT_APP_LANG;
    }
  }

  /**
   * Like {@link langOf} but free when a dialogue is open: an active wizard
   * session already carries the language it was started in (and the /language
   * handler updates it in place), so no read is needed.
   */
  private async resolveLang(tgUserId: number): Promise<AppLang> {
    const session = this.wizard.get(tgUserId);
    if (session) return session.lang;
    return this.langOf(tgUserId);
  }

  /**
   * Persist a seller's language choice and make it effective immediately: the
   * cache, and any dialogue already in progress, both move to the new language
   * so the very next message is in it.
   */
  private async setLang(tgUserId: number, lang: AppLang): Promise<void> {
    await this.sellers.setLanguage(BigInt(tgUserId), toBotLanguage(lang));
    this.langCache.set(tgUserId, lang);
    const session = this.wizard.get(tgUserId);
    if (session) session.lang = lang;
  }

  /** Show the language picker. Its header is trilingual by design. */
  private async promptLanguage(ctx: Context, lang: AppLang): Promise<void> {
    await ctx.reply(t(lang, 'lang.prompt'), languageKeyboard());
  }

  /**
   * Answer a tap on a button from an OUTDATED catalog version. The button's
   * brand/model index can no longer be trusted, so instead of resolving it we
   * show the seller an alert popup on the button, strip the now-dead keyboard,
   * and nudge them to restart.
   *
   * The alert popup fires on EVERY tap (Telegram renders it in place — it never
   * accumulates). The chat NUDGE, however, is deduplicated per user within
   * STALE_NOTICE_DEDUP_MS: several old buttons may still be on screen, and
   * tapping them in quick succession must not stack identical messages.
   *
   * Best-effort: an expired callback (Telegram's ~15 s answer window) is
   * swallowed so the nudge still sends.
   */
  private async answerStaleCallback(ctx: Context): Promise<void> {
    const tgUserId = ctx.from?.id;
    const lang =
      tgUserId === undefined
        ? DEFAULT_APP_LANG
        : await this.resolveLang(tgUserId);
    try {
      // show_alert renders the text as a modal popup rather than a transient
      // toast, so the seller can't miss that the catalog changed.
      await ctx.answerCbQuery(staleCatalogMessage(lang), { show_alert: true });
    } catch {
      // Expired callback — proceed to the follow-up nudge anyway.
    }
    await this.removeInlineKeyboard(ctx);

    // Deduplicate the chat nudge: skip it if we already sent one to this user
    // within the window (rapid repeat taps on stale buttons).
    if (tgUserId !== undefined && !this.shouldSendStaleNotice(tgUserId)) return;
    await ctx.reply(staleCatalogMessage(lang));
  }

  /**
   * Whether the "catalog updated" chat nudge should be sent to this user now.
   * Returns true and records the send time on the first call (or after the
   * dedup window elapses); returns false for repeat taps inside the window.
   * When tgUserId is unknown we can't dedupe, so the caller sends anyway.
   */
  private shouldSendStaleNotice(tgUserId: number): boolean {
    const now = Date.now();
    const last = this.staleNoticeSentAt.get(tgUserId);
    if (last !== undefined && now - last < STALE_NOTICE_DEDUP_MS) return false;
    this.staleNoticeSentAt.set(tgUserId, now);
    return true;
  }

  /**
   * Shared handler for every wizard inline button: answer the callback, apply
   * the transition, and on success strip the tapped keyboard and prompt for the
   * next step. Stale taps (old messages, wrong step, no session) are ignored so
   * a re-tapped historic button can never corrupt the current session.
   */
  private async handleWizardAction(
    ctx: Context,
    transition: (session: WizardSession) => WizardResult | Promise<WizardResult>,
  ): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch {
      // Expired callback (Telegram answers must come within ~15 s) — proceed.
    }
    const from = ctx.from;
    if (!from) return;

    const session = this.wizard.get(from.id);
    if (!session) {
      await ctx.reply(t(await this.langOf(from.id), 'start.hint'));
      return;
    }

    const result = await transition(session);
    if (result.status !== 'ok') return; // stale button — ignore silently

    await this.removeInlineKeyboard(ctx);
    // Persist the answered field to the draft and, when the questionnaire finishes,
    // hand off to the coordinator (rendezvous).
    await this.handleFormAdvance(ctx, from.id, session);
  }

  /** Send the prompt (text + inline keyboard) asking for the session's current step. */
  private async sendStepPrompt(
    ctx: Context,
    session: WizardSession,
  ): Promise<void> {
    await this.ensureCategoryOptions(session);
    const prompt = stepPrompt(session);
    await ctx.reply(prompt.text, prompt.keyboard);
  }

  /**
   * Load the options of EVERY category step before its keyboard is built.
   *
   * This runs on every render of such a step — the first time it is opened AND
   * after a "⬅️ Назад" back onto it. Reloading is not an optimization detail: a
   * pick REPLACES `categoryOptions` with the next level's list (or empties it at
   * a leaf), so a step returned to would otherwise render the wrong buttons, or
   * — the reported bug — none at all. The list is therefore never reused across
   * a step boundary; it is re-read from the live tree, which also picks up any
   * admin change made while the seller was deeper in the flow.
   *
   * Which level to load is read from `categoryOptionsParentId` for the deeper
   * steps and is a constant for the other two: the ROOT level (null) for
   * CATEGORY, and the `other` root for the "Другое" menu.
   */
  private async ensureCategoryOptions(session: WizardSession): Promise<void> {
    switch (session.step) {
      case WizardStep.CATEGORY:
        await this.openCategoryLevel(session, null);
        return;
      // The "Другое" menu is the admin-managed children of the `other` root, so
      // it is loaded from the same tree as every other category step rather than
      // from a hardcoded list — an admin adding a category makes it appear here
      // on the next render, with no redeploy.
      case WizardStep.OTHER_CATEGORY:
        await this.openCategoryLevel(session, CategoryAnchor.OTHER);
        return;
      // A deeper level: whose children to show is remembered on the session,
      // because `categoryId` has by then moved to the node that was PICKED and
      // would yield that node's own children (or none) instead of the level the
      // seller is standing on.
      case WizardStep.SUBCATEGORY:
        await this.openCategoryLevel(session, session.categoryOptionsParentId);
        return;
      default:
        return;
    }
  }

  /**
   * (Re-)open ONE category level: load `parentId`'s children (the roots when
   * null), and record on the session both the list and the level it belongs to,
   * so a tap can be re-validated against the right parent and a later "⬅️ Назад"
   * can re-open exactly this level.
   *
   * `categoryStepPending` follows the list: a level with options is a question
   * the seller still owes an answer to, whatever it was before they walked back.
   * That is what stops a step from staying marked as settled while it is being
   * asked again.
   *
   * A load failure leaves the options empty rather than throwing: the seller then
   * sees the step with only "Назад" instead of the bot dying mid-dialogue.
   */
  private async openCategoryLevel(
    session: WizardSession,
    parentId: string | null,
  ): Promise<void> {
    session.categoryOptions = await this.loadCategoryOptions(
      parentId,
      session.lang,
    );
    session.categoryOptionsParentId = parentId;
    session.categoryStepPending = session.categoryOptions.length > 0;
  }

  /**
   * The category an ANTIFREEZE listing is filed under, read from the LIVE tree:
   * the `antifreeze` node, the root it hangs under, and its package codes (which
   * decide whether the sale-form question follows).
   *
   * Returns null when the node is missing or deactivated — the listing then
   * carries no category ids, exactly as a motor oil did before the dynamic tree
   * existed, rather than pointing at a category that is not there. Its MXIK is
   * then reported as a gap at fiscalization time instead of being invented,
   * which is the same rule every other unconfigured category follows.
   */
  private async loadAntifreezeAnchor(): Promise<CategoryAnchorSelection | null> {
    const category = await this.selectableCategory(
      CategoryAnchor.ANTIFREEZE,
      ANTIFREEZE_ROOT_ID,
    );
    if (!category) {
      this.logger.warn(
        `Antifreeze anchor category "${CategoryAnchor.ANTIFREEZE}" is missing ` +
          `or inactive under "${ANTIFREEZE_ROOT_ID}" — the listing will carry ` +
          'no category ids.',
      );
      return null;
    }
    return {
      vehicleCategoryId: ANTIFREEZE_ROOT_ID,
      categoryId: category.id,
      fiscal: category,
    };
  }

  /**
   * The active children of `parentId` (or the roots when null) as wizard
   * options, carrying the legacy enum mirrors so the draft's compatibility
   * columns stay populated alongside the ids.
   */
  /**
   * Whether a tapped category id is still a legitimate choice RIGHT NOW, per the
   * live tree — not per the keyboard's snapshot.
   *
   * Rejects a category that has since been deleted or deactivated, and one whose
   * parent no longer matches where the seller is standing (a move, a re-parent,
   * or a stale keyboard from another branch). `expectedParent` is null for the
   * root step, which additionally requires the node to BE a root.
   *
   * An inactive PARENT needs no separate check: `findChildren` filters on
   * isActive at each level, so a deactivated parent's children never appear in
   * the options the transition resolves against.
   */
  private async selectableCategory(
    categoryId: string,
    expectedParent: string | null,
  ): Promise<CategoryRow | null> {
    try {
      const category = await this.categories.findById(categoryId);
      if (!category || !category.isActive) return null;
      // The ROW itself is returned, not just a verdict: it carries the fiscal
      // package codes the transition needs, and re-reading them separately
      // would open a window where the tap was validated against one version of
      // the category and fiscalized from another.
      return category.parentId === expectedParent ? category : null;
    } catch (err) {
      // A lookup failure must not silently accept the tap.
      this.logger.error(
        `Category re-validation failed for "${categoryId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Tell the seller a category button no longer applies, and re-ask the step. */
  private async rejectStaleCategoryTap(ctx: Context): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch {
      // Expired callback — proceed to the message below regardless.
    }
    await this.removeInlineKeyboard(ctx);
    const from = ctx.from;
    const session = from ? this.wizard.get(from.id) : undefined;
    await ctx.reply(staleCategoryMessage(session?.lang ?? DEFAULT_APP_LANG));
    // Re-render the step with the CURRENT tree so the seller can carry on.
    if (session) await this.sendStepPrompt(ctx, session);
  }

  private async loadCategoryOptions(
    parentId: string | null,
    lang: AppLang,
  ): Promise<CategoryOption[]> {
    try {
      const rows =
        parentId === null
          ? await this.categories.findRootCategories()
          : await this.categories.findChildren(parentId);
      return rows
        // Hide the 12 mainCategory BUCKETS from the seller drill: they are the
        // home-grid taxonomy (and the classifier's auto-fallback target), NOT a
        // pickable node. A bucket id is exactly a key of MAIN_CATEGORY_BY_SLUG.
        // Sellers now drill roots → the real subcategories; mainCategory is still
        // set from the classifier, so the bucket linkage/counts are unaffected.
        .filter((row) => !MAIN_CATEGORY_BY_SLUG.has(row.id))
        .map((row) => ({
        id: row.id,
        // The BUTTON label, in the seller's language. Resolved here (not in the
        // pure wizard module) because the cached tree carries all three names
        // and only this side knows whose dialogue is being rendered.
        name: localizedCategoryName(row, lang),
        vehicleCategoryEnum: VEHICLE_CATEGORY_BY_SLUG.get(row.id) ?? null,
        mainCategoryEnum: MAIN_CATEGORY_BY_SLUG.get(row.id) ?? null,
        // Resolved from the category's STABLE ID, never its name, so renaming
        // "Моторные масла" in the admin panel cannot change what it does.
        // Undefined for an ordinary category, which makes it a spare part.
        // Own-property check only: a bare index would let an admin category
        // whose id is 'constructor' or 'toString' inherit a truthy value off
        // Object.prototype and pass a non-ProductKind into the wizard.
        kind: Object.prototype.hasOwnProperty.call(CATEGORY_ID_TO_KIND, row.id)
          ? CATEGORY_ID_TO_KIND[row.id]
          : undefined,
      }));
    } catch (err) {
      this.logger.error(
        `Failed to load categories (parentId=${parentId ?? 'root'}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /**
   * Strip the inline keyboard from the message that carried the pressed button
   * without deleting the message. Best-effort: if the edit fails — e.g. the
   * keyboard was already removed by an earlier tap, or the message is too old —
   * the error is logged and swallowed so the action still proceeds.
   */
  private async removeInlineKeyboard(ctx: Context): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch (err) {
      this.logger.debug(
        `Could not remove inline keyboard: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Photo hand-off (single photo or a flushed album). Photos are only ever expected
   * at the PHOTOS_FIRST step — the ONE entry into the image pipeline. Anything else
   * (photos sent mid-questionnaire, or with no session) re-shows what is expected.
   */
  private async handleWizardPhotos(
    ctx: Context,
    tgUserId: number,
    fileIds: string[],
  ): Promise<void> {
    const session = this.wizard.get(tgUserId);
    if (!session) {
      await ctx.reply(t(await this.langOf(tgUserId), 'start.hint'));
      return;
    }
    if (session.step !== WizardStep.PHOTOS_FIRST) {
      // Photos sent outside the upload step — re-show the current question.
      await this.sendStepPrompt(ctx, session);
      return;
    }
    await this.handlePhotos(ctx, tgUserId, session, fileIds);
  }

  // ── Pending confirmation session ────────────────────────────────────────────
  /**
   * Store the single pending confirmation for a user, discarding any existing one
   * (deleting its Cloudinary assets) and arming the expiry. Driven by the
   * ready_for_preview domain event, so there is no ctx — the caller sends the
   * preview itself. Returns whether a previous pending was replaced.
   */
  private storePending(draft: Omit<PendingProduct, 'expiry'>): boolean {
    const replaced = this.pending.has(draft.tgUserId);
    if (replaced) {
      void this.discardPending(draft.tgUserId); // deletes the replaced draft's assets
    }
    const expiry = setTimeout(() => {
      // Auto-expiry drops only the in-memory CACHE, never the assets: the draft is
      // still READY_FOR_PREVIEW and /start re-presents it (with these exact processed
      // URLs) until the TTL sweep expires it. Deleting them here would break that
      // recovery and leave the draft pointing at dead Cloudinary assets. Asset
      // lifetime belongs to the draft: publish keeps them, cancel/sweep deletes them.
      this.takePending(draft.tgUserId);
    }, CONFIRMATION_TTL_MS);
    // Don't keep the process alive just for a pending confirmation.
    expiry.unref?.();
    this.pending.set(draft.tgUserId, { ...draft, expiry });
    return replaced;
  }

  /**
   * Remove a pending session WITHOUT deleting its Cloudinary assets. Used by a
   * successful commit, where the assets are kept for the saved product.
   */
  private takePending(tgUserId: number): PendingProduct | undefined {
    const session = this.pending.get(tgUserId);
    if (session) {
      clearTimeout(session.expiry);
      this.pending.delete(tgUserId);
    }
    return session;
  }

  /**
   * Discard a pending record AND delete its uploaded Cloudinary assets. Used when a
   * new preview REPLACES an older one for the same user, whose assets nothing owns
   * any more. Cleanup failures are logged by CloudinaryService and never throw, so
   * the discard always completes.
   */
  private async discardPending(tgUserId: number): Promise<void> {
    const session = this.takePending(tgUserId);
    if (session && session.publicIds.length > 0) {
      await this.cloudinary.deleteAssets(session.publicIds);
    }
  }

  /**
   * Send the preview to the seller's chat. Always ctx-free: the preview is emitted by
   * the ready_for_preview domain event, which may fire from the image worker's thread
   * long after the form finished, so there is no live ctx — only the chat id.
   */
  private async sendPreviewToChat(
    chatId: number,
    listing: Omit<PendingProduct, 'expiry'>,
    processedUrls: string[],
  ): Promise<void> {
    // The preview is composed here rather than in `buildPreview` because both
    // the language and the category's localized name are I/O — and buildPreview
    // is a pure formatter shared with the tests.
    const lang = await this.langOf(chatId);
    const { caption, buttons } = this.buildPreview(
      listing,
      lang,
      await this.categoryLabel(listing, lang),
    );
    try {
      if (processedUrls.length === 1) {
        await this.bot.telegram.sendPhoto(chatId, processedUrls[0], {
          caption,
          parse_mode: 'Markdown',
          ...buttons,
        });
        return;
      }
      const media = processedUrls
        .slice(0, MAX_IMAGES_PER_LISTING)
        .map((url) => ({ type: 'photo' as const, media: url }));
      await this.bot.telegram.sendMediaGroup(chatId, media);
      await this.bot.telegram.sendMessage(chatId, caption, {
        parse_mode: 'Markdown',
        ...buttons,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to send preview media to chat ${chatId}, falling back to text: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.bot.telegram.sendMessage(chatId, caption, {
        parse_mode: 'Markdown',
        ...buttons,
      });
    }
  }

  /**
   * The preview's category line, in the seller's language.
   *
   * Read from the DYNAMIC tree by the id the seller actually picked, so a
   * category the admin renamed or translated shows its current name. Falls back
   * to the legacy enum label map when the listing carries no category id (a
   * pre-migration draft) or the row has gone — the preview must render either
   * way, and a missing translation is not worth failing a listing over.
   */
  private async categoryLabel(
    listing: Omit<PendingProduct, 'expiry'>,
    lang: AppLang,
  ): Promise<string | undefined> {
    const id = listing.vehicleCategoryId;
    if (!id) return undefined;
    try {
      const row = await this.categories.findById(id);
      return row ? localizedCategoryName(row, lang) : undefined;
    } catch (err) {
      this.logger.warn(
        `Could not localize category "${id}" for the preview: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /**
   * Build the preview caption + confirmation keyboard (shared by both senders).
   * The shared lines (title, description, price) are rendered here; the lines
   * peculiar to the listing's KIND come from `previewLines`, so a motor oil shows
   * viscosity / type / volume where a spare part shows vehicle / category /
   * number, and neither kind renders the other's fields.
   */
  private buildPreview(
    listing: Omit<PendingProduct, 'expiry'>,
    lang: AppLang = DEFAULT_APP_LANG,
    categoryLabel?: string,
  ): {
    caption: string;
    buttons: ReturnType<typeof Markup.inlineKeyboard>;
  } {
    const { metadata, price } = listing;
    // Label the number by how the seller marked it — never guess. An unlabeled
    // number shows the neutral "OEM/GM №" so we don't claim a type we don't know.
    const numberLabel =
      metadata.part_number_type === 'GM'
        ? 'GM №'
        : metadata.part_number_type === 'OEM'
          ? 'OEM №'
          : 'OEM/GM №';

    const kindLines = previewLines(
      {
        kind: listing.kind,
        vehicleCategoryLabel:
          categoryLabel ??
          (listing.vehicleCategory
            ? (CATEGORY_LABELS.get(listing.vehicleCategory) ?? '—')
            : '—'),
        partNumberLabel: numberLabel,
        partNumber: metadata.gm_number,
        oilViscosity: listing.oilViscosity,
        oilType: listing.oilType,
        oilVolumeMl: listing.oilVolumeMl,
        // The listing's own universality, so an oil sold for a specific car
        // shows that car in the preview while a "Другое" oil shows none.
        isUniversal: metadata.isUniversal,
      },
      formatVehicleLine(metadata, lang),
      lang,
    );

    const caption = [
      `${t(lang, 'preview.header')}\n`,
      `🔩 *${t(lang, 'preview.title')}:* ${metadata.title}`,
      `📝 *${t(lang, 'preview.description')}:* ${metadata.description ?? '—'}`,
      ...kindLines,
      `💰 *${t(lang, 'preview.price')}:* ${price.toFixed(0)} UZS`,
    ].join('\n');

    const buttons = Markup.inlineKeyboard([
      [
        Markup.button.callback(t(lang, 'btn.addProduct'), CONFIRM_ADD),
        Markup.button.callback(t(lang, 'btn.cancelProduct'), CONFIRM_CANCEL),
      ],
      // Back edits text/price reusing these photos (no re-processing);
      // "change photos" replaces them (re-runs the image pipeline).
      [
        Markup.button.callback(t(lang, 'btn.back'), CONFIRM_BACK),
        Markup.button.callback(t(lang, 'btn.changePhotos'), CONFIRM_CHANGE_PHOTOS),
      ],
    ]);
    return { caption, buttons };
  }

  /**
   * Commit a confirmed pending product: perform the database writes, then send a
   * simple success message (the preview already showed the full product). No-op
   * with a notice if there is nothing to confirm. Uploaded assets are kept.
   */
  private async commitPending(ctx: Context, tgUserId: number): Promise<void> {
    // Take the session (without deleting its Cloudinary assets — the saved
    // product keeps them). A cache miss (TTL eviction / restart) falls back to the
    // draft: the `pending` map is a UX cache, so losing it must not cost the seller
    // a confirmed listing.
    const lang = await this.langOf(tgUserId);
    const session =
      this.takePending(tgUserId) ??
      (await this.rebuildPendingFromDraft(tgUserId));
    if (!session) {
      await ctx.reply(t(lang, 'confirm.nothingPending'));
      return;
    }

    // Claim the draft BEFORE writing the product. Consuming the in-memory record
    // used to be what made a double-tap safe; now that a cache miss falls back to
    // the DB, two rapid taps could both rebuild the same draft and both commit
    // (the `gmNumber` upsert does NOT dedupe them — an unlabeled part gets a
    // per-call `tg_<id>_<now>` key). This versioned CAS is the real guard: exactly
    // one caller takes READY_FOR_PREVIEW → COMMITTING and proceeds.
    //
    // COMMITTING — not PUBLISHED — is the claim, so the status never claims an
    // outcome that has not happened yet. A crash between here and the product write
    // leaves a COMMITTING draft: recoverable and sweepable (its assets are reclaimed
    // once the TTL passes), unlike a PUBLISHED draft with no product, which the
    // sweep deliberately refuses to touch and would leak assets forever.
    const claimed = await this.drafts.tryTransition(
      session.draftId,
      DraftStatus.READY_FOR_PREVIEW,
      DraftStatus.COMMITTING,
      session.draftVersion,
    );
    if (!claimed) {
      await ctx.reply(t(lang, 'confirm.alreadyProcessed'));
      return;
    }
    // The claim bumped the row's version; the PUBLISHED transition below must
    // present this one.
    const committingVersion = session.draftVersion + 1;

    const {
      sellerId,
      metadata,
      title,
      vehicleCategory,
      subcategory,
      vehicleCategoryId,
      categoryId,
      processedUrls,
      price,
    } = session;

    // Re-validate the category lineage against the DB before it becomes a
    // Product. The bot's own keyboards can only produce coherent pairs, but this
    // must hold for ANY caller — a forged callback, a replayed draft, or a
    // category the admin moved/deactivated between the pick and the commit.
    // A pair that no longer makes sense is dropped (the listing keeps its legacy
    // enum taxonomy) rather than failing the seller's commit outright.
    let validatedVehicleCategoryId = vehicleCategoryId;
    let validatedCategoryId = categoryId;
    // True only when a pair EXISTED and failed validation — never for a draft
    // that legitimately carries no category (MOTOR_OIL, pre-migration rows).
    let categoryPairWasRejected = false;
    if (vehicleCategoryId && categoryId) {
      try {
        await this.categories.validateCategorySelection(
          vehicleCategoryId,
          categoryId,
        );
      } catch (err) {
        this.logger.warn(
          `Draft ${session.draftId} has an invalid category pair ` +
            `(vehicle=${vehicleCategoryId}, category=${categoryId}): ` +
            `${err instanceof Error ? err.message : String(err)} — storing none.`,
        );
        validatedVehicleCategoryId = null;
        validatedCategoryId = null;
        categoryPairWasRejected = true;
      }
    }

    // Keep the LEGACY ENUM MIRRORS consistent with whatever survived validation.
    // Dropping the ids while still writing the draft's stale enums would leave a
    // Product whose enum taxonomy contradicts its (now empty) category ids — the
    // classifier's inference is the honest fallback there, exactly as it is for
    // a pre-migration listing. When the pair IS valid, the enums are re-derived
    // from the ids rather than trusted from the draft, so a category the admin
    // re-parented cannot leave a mirror pointing at its old branch.
    const mirroredVehicleCategory =
      validatedVehicleCategoryId === null
        ? null
        : (VEHICLE_CATEGORY_BY_SLUG.get(validatedVehicleCategoryId) ?? null);
    const mirroredSubcategory =
      validatedCategoryId === null
        ? null
        : (MAIN_CATEGORY_BY_SLUG.get(validatedCategoryId) ?? null);

    try {
      const primaryUrl = processedUrls[0];
      const gmKey = metadata.gm_number ?? `tg_${tgUserId}_${Date.now()}`;

      // Split the seller's part number into the GM / OEM columns by its LABELED
      // type — never cross-copy. A GM-labeled number fills gmNumber only; an
      // OEM-labeled one fills oemNumber only; an unlabeled (UNKNOWN) number stays
      // in gmNumber (the unique key) and is exposed to both searches at
      // projection time. The type itself is persisted so the split is auditable.
      const partNumberType = metadata.part_number_type ?? 'UNKNOWN';
      const { oemNumber } = splitPartNumber(metadata.gm_number, partNumberType);

      // Keyword-classify the remaining stored attributes (main/home category,
      // region of origin, make). The wizard's brand/model are appended to the
      // classifier text so make-based region inference works exactly as it did
      // when captions carried the vehicle name in free text. The category the
      // seller chose explicitly is written verbatim below — never overridden by
      // the classifier. The OEM/GM flags come EXCLUSIVELY from `partNumberType`
      // (the single label rule) — not re-scanned from text.
      const classifierText = [
        metadata.description,
        metadata.brand,
        ...metadata.models,
      ]
        .filter((part): part is string => !!part)
        .join(' ');
      const classification = classifyPart(
        title,
        classifierText,
        partNumberType,
      );
      const classifiedFields = {
        // The seller's explicit subcategory wins over the keyword guess — the
        // same rule the vehicle category already follows. Null (a category with
        // no subcategories or no enum equivalent, so there is nothing to mirror)
        // falls back to the classifier's inference, leaving those listings
        // exactly as before.
        //
        // The mirror is derived from the VALIDATED id, not read from the draft:
        // that is what stops a dropped/invalid pair from leaving behind an enum
        // taxonomy the ids no longer support.
        //
        // `categoryPairWasRejected` distinguishes the two null cases. A draft
        // that simply never had ids (pre-migration, or a kind that asks no
        // category) still falls back to its own enums — unchanged behaviour. A
        // draft whose pair was REJECTED has its enums dropped too, because those
        // are precisely the values that just failed validation; the classifier's
        // inference is the honest fallback there.
        mainCategory: categoryPairWasRejected
          ? classification.mainCategory
          : (mirroredSubcategory ?? subcategory ?? classification.mainCategory),
        vehicleCategory: categoryPairWasRejected
          ? null
          : (mirroredVehicleCategory ?? vehicleCategory),
        // The dynamic tree ids the seller chose, copied verbatim from the draft
        // (never reconstructed from a category NAME, and never re-derived from
        // the classifier's guess).
        vehicleCategoryId: validatedVehicleCategoryId,
        categoryId: validatedCategoryId,
        // The sale form selects one of the CATEGORY's package codes, so it is
        // meaningless without a category: a rejected pair drops it along with
        // the ids, rather than leaving a form pointing at codes this listing no
        // longer has. Always stated (never omitted) so a re-listing that
        // changes category cannot keep the previous one's answer.
        packageForm: validatedCategoryId === null ? null : session.packageForm,
        partBrand: classification.make,
        originRegion: classification.originRegion,
        isOem: classification.isOem,
        isGm: classification.isGm,
        oemNumber,
        partNumberType,
      };

      // Attributes owned by the listing's KIND. A motor oil's taxonomy is not a
      // guess to be classified — the seller told us what it is by choosing the
      // category — so the two category columns are set from the kind and the
      // classifier's inference for them is deliberately overridden. Every other
      // classified field (region, part brand) still applies.
      const kindFields = this.buildKindFields(session);

      const product = await this.prisma.product.upsert({
        where: { gmNumber: gmKey },
        update: {
          title,
          description: metadata.description,
          imageUrl: primaryUrl,
          isUniversal: metadata.isUniversal,
          ...classifiedFields,
          ...kindFields,
        },
        create: {
          gmNumber: metadata.gm_number,
          title,
          description: metadata.description,
          imageUrl: primaryUrl,
          isUniversal: metadata.isUniversal,
          ...classifiedFields,
          ...kindFields,
        },
      });

      // Vehicle compatibility: universal → no part_models rows; otherwise one
      // row per (brand, model) pair, each model under ITS OWN brand.
      await persistVehicleLinks(this.prisma, product.id, metadata);

      // Replace the product gallery with the new ordered set (first = primary).
      await this.prisma.productImage.deleteMany({
        where: { productId: product.id },
      });
      await this.prisma.productImage.createMany({
        data: processedUrls.map((url, i) => ({
          productId: product.id,
          url,
          sortOrder: i,
          isPrimary: i === 0,
        })),
      });

      const stock = await this.prisma.stock.upsert({
        where: { sellerId_productId: { sellerId, productId: product.id } },
        update: { priceUzs: price },
        create: { sellerId, productId: product.id, priceUzs: price },
      });

      // Live projection into the buyer catalog: this confirmed listing becomes a
      // CatalogPart immediately, so no manual backfill is needed. Projection is
      // best-effort — the supply-side write already succeeded, so a projection
      // failure must not fail the seller's confirmation; it is logged and the
      // next update (or a backfill) will reconcile.
      await this.projectToCatalog(stock.id);

      // The product write succeeded, so close the claim: COMMITTING → PUBLISHED (so
      // the TTL sweep never touches it — critical because the sweep covers COMMITTING
      // precisely to reclaim a crashed commit) and delete the STORED ORIGINALS (the
      // processed URLs are now the product's images and are kept). Best-effort: a
      // failure here must NOT fail the already-committed product.
      await this.finalizePublishedDraft(session.draftId, sellerId);

      // The preview already served as the confirmation UI — the success message
      // only needs to confirm the write completed. Do not resend product details.
      await ctx.reply(t(lang, 'confirm.success'));
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error
          ? error.message
          : typeof error === 'object'
            ? JSON.stringify(error)
            : String(error);
      this.logger.error(
        `Commit error: ${errMsg}`,
        error instanceof Error ? error.stack : undefined,
      );
      await ctx.reply(t(lang, 'confirm.failed', { error: errMsg }), {
        parse_mode: 'Markdown',
      });
    }
  }

  /**
   * The Product columns owned by a listing's KIND — written on both the create
   * and the update branch of the commit upsert, AFTER the classified fields, so
   * an explicit choice always beats an inference.
   *
   * Each kind returns the same column set (its own attributes filled, the other
   * kinds' nulled) so a re-listing that CHANGES kind — the same part number
   * re-published as an oil, or vice versa — leaves no stale attribute behind.
   * That is the reason for the explicit nulls rather than simply omitting them:
   * the upsert's update branch would otherwise preserve the old kind's values.
   *
   * A new kind adds one case; nothing else in the commit path changes.
   */
  private buildKindFields(listing: Omit<PendingProduct, 'expiry'>): {
    kind: ProductKind;
    oilViscosity: string | null;
    oilType: OilType | null;
    oilVolumeMl: number | null;
    antifreezeWeightG: number | null;
    mainCategory?: PartMainCategory;
    vehicleCategory?: PartVehicleCategory;
  } {
    // Every branch states EVERY attribute column, so no value of a kind the
    // listing no longer is can survive the upsert's update branch. Written out
    // per case (rather than spread from a "blank" object) so the compiler still
    // reports a missing column in each one.
    switch (listing.kind) {
      case ProductKind.MOTOR_OIL:
        return {
          kind: ProductKind.MOTOR_OIL,
          oilViscosity: listing.oilViscosity,
          oilType: listing.oilType,
          oilVolumeMl: listing.oilVolumeMl,
          antifreezeWeightG: null,
          // A motor oil's taxonomy is known from the kind itself, so both
          // category columns are stated rather than classified — this is what
          // makes an oil filterable in the buyer catalog even though its
          // questionnaire never asked a category question.
          mainCategory: PartMainCategory.OIL_AND_FLUIDS,
          vehicleCategory: PartVehicleCategory.MAINTENANCE_AND_FLUIDS,
        };
      case ProductKind.ANTIFREEZE:
        return {
          kind: ProductKind.ANTIFREEZE,
          // The oil columns are explicitly nulled: an antifreeze listing must
          // NEVER carry an oilType, because that column is what selects an
          // oil's MXIK / package code. A stray value there would fiscalize
          // antifreeze under a motor-oil code.
          oilViscosity: null,
          oilType: null,
          oilVolumeMl: null,
          antifreezeWeightG: listing.antifreezeWeightG,
          // Same rule as the oil above: the taxonomy follows from the kind, and
          // it matches the `antifreeze` category the wizard files it under
          // (a leaf of the maintenance-and-fluids root).
          mainCategory: PartMainCategory.OIL_AND_FLUIDS,
          vehicleCategory: PartVehicleCategory.MAINTENANCE_AND_FLUIDS,
        };
      case ProductKind.SPARE_PART:
        return {
          kind: ProductKind.SPARE_PART,
          oilViscosity: null,
          oilType: null,
          oilVolumeMl: null,
          antifreezeWeightG: null,
        };
    }
  }

  /**
   * Project a just-written Stock row into the buyer catalog through the single
   * authoritative mapping (CatalogProjectionService). Best-effort: the
   * supply-side write has already committed, so a projection failure is logged
   * and swallowed rather than surfaced to the seller — the next Stock change or
   * a backfill run will reconcile the missing CatalogPart.
   */
  private async projectToCatalog(stockId: number): Promise<void> {
    try {
      await this.catalogProjection.projectStock(stockId);
    } catch (err) {
      this.logger.error(
        `Catalog projection failed for stock #${stockId}: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
