import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { DraftStatus, PartVehicleCategory, SellerStatus } from '@prisma/client';
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
import { persistVehicleLinks } from './vehicle-links';
import {
  ProductDraftService,
  type DraftWithImages,
} from './product-draft.service';
import { DraftCoordinator } from './draft-coordinator';
import { DraftTelemetry, DraftMetric } from './draft-telemetry';
import {
  DraftEvent,
  type DraftImagesFailedEvent,
  type DraftReadyForPreviewEvent,
} from './draft-events';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  WizardResult,
  WIZ_BRAND_ACTION,
  WIZ_MODEL_ACTION,
  WIZ_CATEGORY_ACTION,
  WIZ_DESCRIPTION_SKIP,
  WIZ_PART_NUMBER_TYPE_ACTION,
  WIZ_BACK_ACTION,
  WIZ_ANY_ACTION,
  isStaleCatalogPayload,
  STALE_CATALOG_MESSAGE,
  selectBrand,
  selectModel,
  selectCategory,
  inputTitle,
  inputDescription,
  skipDescription,
  choosePartNumberType,
  inputPartNumber,
  inputPrice,
  beginQuestionnaire,
  goBack,
  stepPrompt,
} from './product-wizard';
import { WIZARD_CATEGORIES } from './wizard-catalog';

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

// Nudge shown to anyone interacting outside an active wizard session.
const START_HINT = '👋 Чтобы добавить товар, нажмите /start';

// Russian label for a stored PartVehicleCategory, from the wizard catalog (the
// single source of truth for these labels). Used in the preview so the seller
// sees the category they picked.
const CATEGORY_LABELS = new Map(
  WIZARD_CATEGORIES.map((c) => [c.value, c.label]),
);

// Guide describing the new step-by-step wizard, reachable via /help. Purely
// informational — it does NOT touch the wizard or listing pipeline.
const HELP_MESSAGE =
  '📦 Как добавить товар\n\n' +
  'Нажмите /start — бот проведёт вас по шагам:\n\n' +
  '1️⃣ Фотографии — одно фото или альбом до 10 фото\n' +
  '2️⃣ Марка автомобиля (кнопка)\n' +
  '3️⃣ Модель (кнопка)\n' +
  '4️⃣ Категория запчасти (кнопка)\n' +
  '5️⃣ Название товара (текст)\n' +
  '6️⃣ Описание — можно пропустить\n' +
  '7️⃣ Тип номера: OEM, GM или пропустить\n' +
  '8️⃣ Номер детали (если выбрали OEM/GM)\n' +
  '9️⃣ Цена в сумах\n\n' +
  '⚡ Фото обрабатываются в фоне, пока вы заполняете информацию — ждать не нужно.\n' +
  '✅ Когда всё готово, бот покажет предпросмотр — проверьте и нажмите «Добавить товар».\n\n' +
  '💡 Марку и модель выбирайте только кнопками — вводить их вручную не нужно.\n' +
  '🔎 Если указать OEM или GM номер, покупателям будет намного проще найти вашу деталь через поиск.';

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
  /** Validated non-null title (guaranteed by the wizard's TITLE step). */
  title: string;
  /** The wizard's explicit category choice — written to Product.vehicleCategory
   *  verbatim (never overridden by the keyword classifier). */
  vehicleCategory: PartVehicleCategory;
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
export function formatVehicleLine(metadata: ParseOutcome): string {
  if (metadata.isUniversal) return 'Все автомобили (универсальная деталь)';

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
 * Rebuild the wizard's conversational state from a draft, positioning the dialogue
 * at `step`. Used by /start resume and by the preview's "⬅️ Назад" edit — the draft
 * supplies every answered field, so the seller re-enters nothing. Images are NOT
 * represented here: they belong to the draft's image rows.
 */
export function buildSessionFromDraft(
  draft: {
    id: string;
    brand: string | null;
    model: string | null;
    category: PartVehicleCategory | null;
    title: string | null;
    description: string | null;
    partNumberType: ParseOutcome['part_number_type'];
    partNumber: string | null;
    priceUzs: Decimal | null;
  },
  step: WizardStep,
): WizardSession {
  return {
    step,
    draftId: draft.id,
    brand: draft.brand,
    model: draft.model,
    category: draft.category,
    title: draft.title,
    description: draft.description,
    partNumberType: draft.partNumberType ?? 'UNKNOWN',
    partNumber: draft.partNumber,
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
    this.wizard.clear();
    this.staleNoticeSentAt.clear();
    for (const session of this.pending.values()) clearTimeout(session.expiry);
    this.pending.clear();
    this.bot?.stop('SIGTERM');
  }

  private registerHandlers() {
    // /start: no instruction message — an ACTIVE seller goes straight into the
    // product-creation wizard (restarting any wizard already in progress).
    this.bot.start(async (ctx) => {
      const from = ctx.from;
      if (!from) return;

      const seller = await this.sellers.upsertFromBot(
        BigInt(from.id),
        from.username ?? from.first_name,
      );

      if (seller.status === SellerStatus.ACTIVE) {
        // New session: forget any prior stale-notice dedup marker so the first
        // stale tap after this restart is acknowledged in chat again.
        this.staleNoticeSentAt.delete(from.id);
        // A restart abandons the current dialogue position. The draft it pointed at
        // is NOT discarded here — startProductCreation offers to resume it (or, if
        // the seller chooses "Начать заново", cancels it explicitly).
        this.wizard.delete(from.id);
        await this.startProductCreation(ctx, from.id, seller.id);
        return;
      }
      if (seller.status === SellerStatus.REJECTED) {
        await ctx.reply('⛔ Ваша заявка отклонена администратором.');
        return;
      }
      await ctx.reply(
        '⏳ Ваша заявка на регистрацию принята и ожидает одобрения администратора.\n' +
          'Как только аккаунт будет активирован, вы сможете добавлять товары.',
      );
    });

    // Informational guide describing the wizard flow. Sends static text and
    // touches nothing in the wizard/listing pipeline (does not start a session).
    this.bot.command('help', async (ctx) => {
      await ctx.reply(HELP_MESSAGE);
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

    this.bot.action(WIZ_CATEGORY_ACTION, async (ctx) => {
      await this.handleWizardAction(ctx, (session) =>
        selectCategory(session, Number(ctx.match[1])),
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

      const session = this.wizard.get(from.id);
      if (!session) {
        await ctx.reply(START_HINT);
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
      if (from) {
        // Terminal: delete the preview's assets, mark the backing draft CANCELLED,
        // and clear the dialogue so the flow ends fully.
        await this.cancelPendingDraft(from.id);
        this.wizard.delete(from.id);
      }
      await ctx.reply(
        '❌ Добавление товара отменено.\nНажмите /start, чтобы начать заново.',
      );
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
      if (!seller || seller.status !== SellerStatus.ACTIVE) {
        await ctx.reply(START_HINT);
        return;
      }
      // Discard the old draft (assets + jobs) and begin a brand-new flow.
      await this.cancelActiveDraft(from.id);
      await this.startProductCreation(ctx, from.id, seller.id);
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
      await this.cancelActiveDraft(from.id);
      await ctx.reply(
        '❌ Создание товара отменено.\nНажмите /start, чтобы начать заново.',
      );
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
  private async startProductCreation(
    ctx: Context,
    tgUserId: number,
    sellerId: number,
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

    const resumable = await this.drafts.findResumable(sellerId);
    if (resumable) {
      await ctx.reply(
        'У вас есть незавершённое объявление.\nПродолжить или начать заново?',
        Markup.inlineKeyboard([
          [
            Markup.button.callback('▶️ Продолжить', DRAFT_RESUME),
            Markup.button.callback('🆕 Начать заново', DRAFT_RESTART),
          ],
        ]),
      );
      return;
    }
    const session = this.wizard.start(tgUserId);
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
    if (!seller) {
      await ctx.reply('👋 Сначала зарегистрируйтесь: введите /start');
      return;
    }
    if (seller.status === SellerStatus.PENDING) {
      await ctx.reply('⏳ Ваша заявка ещё не одобрена. Пожалуйста, подождите.');
      return;
    }
    if (seller.status === SellerStatus.REJECTED) {
      await ctx.reply('⛔ Ваш аккаунт отклонён администратором.');
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
      await ctx.reply('⚠️ Не удалось принять фото. Попробуйте ещё раз.');
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

    await ctx.reply(
      `✅ Фото получены (${images.length} шт.). Пока мы их обрабатываем, заполните информацию о товаре.`,
    );
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
      this.wizard.delete(tgUserId);
      await ctx.reply(START_HINT);
      return;
    }

    // Persist the current field snapshot (idempotent; cheap).
    await this.drafts.updateForm(session.draftId, {
      formStep: session.step,
      brand: session.brand,
      model: session.model,
      category: session.category,
      title: session.title,
      description: session.description,
      partNumberType: session.partNumberType,
      partNumber: session.partNumber,
      priceUzs: session.price ?? undefined,
    });

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
        await ctx.reply('⏳ Завершаем обработку фото…');
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
   * At least one image failed after retries (draft stays CREATING, form data kept).
   * Offer the seller retry (re-enqueue only the failed photos) or cancel. Replacing
   * photos is done by starting over (/start), so no separate button is needed.
   */
  @OnEvent(DraftEvent.IMAGES_FAILED)
  async onDraftImagesFailed(event: DraftImagesFailedEvent): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(
        Number(event.tgId),
        `⚠️ Не удалось обработать ${event.failedCount} фото. ` +
          'Ваши данные сохранены — можно повторить обработку.',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔁 Повторить', DRAFT_RETRY_IMAGES)],
          [Markup.button.callback('❌ Отмена', DRAFT_CANCEL)],
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
    await this.locks.withLock(
      RedisKeys.lockDraftPreview(draftId),
      () => this.deliverDraftPreview(draftId, chatId),
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

    if (
      processedUrls.length === 0 ||
      draft.title === null ||
      draft.brand === null ||
      draft.model === null ||
      draft.category === null ||
      draft.priceUzs === null
    ) {
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

    const metadata = this.buildMetadataFromDraft(draft);
    const price = new Decimal(draft.priceUzs);

    this.storePending({
      sellerId: draft.sellerId,
      tgUserId: chatId,
      metadata,
      title: draft.title,
      vehicleCategory: draft.category,
      processedUrls,
      publicIds,
      price,
      draftId: draft.id,
      // claimPreviewSend incremented the version, so the row is now at read+1.
      // The "⬅️ Назад" edit uses this to take the optimistic lock without a re-read.
      draftVersion: draft.version + 1,
    });

    await this.sendPreviewToChat(
      chatId,
      metadata,
      draft.category,
      processedUrls,
      price,
    );
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

  /** Map a draft's collected fields into the ParseOutcome the preview/commit use. */
  private buildMetadataFromDraft(draft: {
    brand: string | null;
    model: string | null;
    title: string | null;
    description: string | null;
    partNumber: string | null;
    partNumberType: ParseOutcome['part_number_type'];
    priceUzs: Decimal | null;
  }): ParseOutcome {
    const brand = draft.brand ?? '';
    const model = draft.model ?? '';
    return {
      title: draft.title ?? '',
      description: draft.description,
      brand,
      models: [model],
      vehicles: [{ brand, model }],
      isUniversal: false,
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
    if (!seller || seller.status !== SellerStatus.ACTIVE) {
      await ctx.reply(START_HINT);
      return;
    }
    const draft = await this.drafts.findResumable(seller.id);
    if (!draft) {
      await ctx.reply(
        '⌛ Незавершённое объявление больше недоступно. Нажмите /start, чтобы начать заново.',
      );
      return;
    }

    // Rebuild the dialogue from the draft's saved state (the single source of truth).
    const session = buildSessionFromDraft(
      draft,
      (draft.formStep as WizardStep) ?? WizardStep.BRAND,
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
        '⚠️ Часть фото не обработалась. Можно повторить обработку.',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔁 Повторить', DRAFT_RETRY_IMAGES)],
          [Markup.button.callback('❌ Отмена', DRAFT_CANCEL)],
        ]),
      );
      return;
    }
    if (session.step === WizardStep.QUESTIONNAIRE_DONE) {
      // Form already complete — either images are still going or just finished.
      await this.draftCoordinator.onFormStep(draft.id);
      await ctx.reply('⏳ Завершаем обработку фото…');
      return;
    }
    await ctx.reply('▶️ Продолжаем. Заполните оставшиеся поля.');
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
    if (!seller) {
      await ctx.reply(START_HINT);
      return;
    }
    const draft = await this.drafts.findResumable(seller.id);
    if (!draft) {
      await ctx.reply(
        '⌛ Незавершённое объявление больше недоступно. Нажмите /start, чтобы начать заново.',
      );
      return;
    }
    const reset = await this.drafts.resetFailedImages(draft.id);
    const toReenqueue = reset.filter(
      (img) => img.status === 'PROCESSING' && !img.processedUrl,
    );
    if (toReenqueue.length === 0) {
      await ctx.reply('Нет фото для повторной обработки.');
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
    await ctx.reply(
      '🔁 Повторяем обработку фото. Мы сообщим, когда будет готово.',
    );
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
   */
  private async cancelPendingDraft(tgUserId: number): Promise<void> {
    const pending = this.takePending(tgUserId);
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
        `Failed to cancel draft ${pending.draftId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * "⬅️ Назад" on the preview — edit text/price. Moves the backing draft from
   * READY_FOR_PREVIEW back to CREATING (versioned) and restores the dialogue at the
   * PRICE step. The draft's images stay READY and their assets are UNTOUCHED, so
   * re-submitting the form rebuilds the preview with NO image re-processing: the
   * coordinator's rendezvous simply passes again on the image axis.
   *
   * A missing/expired pending record, or a draft that has moved on, is reported and
   * left alone (nothing to reopen).
   */
  private async reopenDraftForEdit(
    ctx: Context,
    tgUserId: number,
  ): Promise<void> {
    const pending = this.takePending(tgUserId);
    if (!pending) {
      await ctx.reply(
        '⌛ Нет товара для редактирования (возможно, время истекло). Нажмите /start, чтобы начать заново.',
      );
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
      await ctx.reply(
        '⌛ Это объявление больше нельзя изменить. Нажмите /start, чтобы начать заново.',
      );
      return;
    }

    const draft = await this.drafts.findWithImages(pending.draftId);
    if (!draft) {
      await ctx.reply(
        '⌛ Это объявление больше нельзя изменить. Нажмите /start, чтобы начать заново.',
      );
      return;
    }
    const session = buildSessionFromDraft(draft, WizardStep.PRICE);
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
    const pending = this.takePending(tgUserId);
    if (!pending) {
      await ctx.reply(
        '⌛ Нет товара для редактирования (возможно, время истекло). Нажмите /start, чтобы начать заново.',
      );
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
      await ctx.reply(
        '⌛ Это объявление больше нельзя изменить. Нажмите /start, чтобы начать заново.',
      );
      return;
    }

    // Open the dialogue on the clone at PHOTOS_FIRST: the next album creates its
    // image rows and enqueues them like any first upload.
    const session = buildSessionFromDraft(clone, WizardStep.PHOTOS_FIRST);
    this.wizard.restore(tgUserId, session);
    await ctx.reply(
      '🖼 Отправьте новые фотографии — остальные данные товара сохранены.',
    );
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
    try {
      // show_alert renders the text as a modal popup rather than a transient
      // toast, so the seller can't miss that the catalog changed.
      await ctx.answerCbQuery(STALE_CATALOG_MESSAGE, { show_alert: true });
    } catch {
      // Expired callback — proceed to the follow-up nudge anyway.
    }
    await this.removeInlineKeyboard(ctx);

    // Deduplicate the chat nudge: skip it if we already sent one to this user
    // within the window (rapid repeat taps on stale buttons).
    const tgUserId = ctx.from?.id;
    if (tgUserId !== undefined && !this.shouldSendStaleNotice(tgUserId)) return;
    await ctx.reply(STALE_CATALOG_MESSAGE);
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
    transition: (session: WizardSession) => WizardResult,
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
      await ctx.reply(START_HINT);
      return;
    }

    const result = transition(session);
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
    const prompt = stepPrompt(session);
    await ctx.reply(prompt.text, prompt.keyboard);
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
      await ctx.reply(START_HINT);
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
    metadata: ParseOutcome,
    vehicleCategory: PartVehicleCategory,
    processedUrls: string[],
    price: Decimal,
  ): Promise<void> {
    const { caption, buttons } = this.buildPreview(
      metadata,
      vehicleCategory,
      price,
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

  /** Build the preview caption + confirmation keyboard (shared by both senders). */
  private buildPreview(
    metadata: ParseOutcome,
    vehicleCategory: PartVehicleCategory,
    price: Decimal,
  ): { caption: string; buttons: ReturnType<typeof Markup.inlineKeyboard> } {
    const vehicle = formatVehicleLine(metadata);
    const categoryLabel = CATEGORY_LABELS.get(vehicleCategory) ?? '—';
    // Label the number by how the seller marked it — never guess. An unlabeled
    // number shows the neutral "OEM/GM №" so we don't claim a type we don't know.
    const numberLabel =
      metadata.part_number_type === 'GM'
        ? 'GM №'
        : metadata.part_number_type === 'OEM'
          ? 'OEM №'
          : 'OEM/GM №';

    const caption =
      `📋 *Проверьте товар перед добавлением.*\n\n` +
      `🔩 *Название:* ${metadata.title}\n` +
      `📝 *Описание:* ${metadata.description ?? '—'}\n` +
      `🚗 *Автомобиль:* ${vehicle}\n` +
      `🗂 *Категория:* ${categoryLabel}\n` +
      `🔢 *${numberLabel}:* ${metadata.gm_number ?? '—'}\n` +
      `💰 *Цена:* ${price.toFixed(0)} UZS`;

    const buttons = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Добавить товар', CONFIRM_ADD),
        Markup.button.callback('❌ Отменить', CONFIRM_CANCEL),
      ],
      // "⬅️ Назад" edits text/price reusing these photos (no re-processing);
      // "🖼 Изменить фото" replaces the photos (re-runs the image pipeline).
      [
        Markup.button.callback('⬅️ Назад', CONFIRM_BACK),
        Markup.button.callback('🖼 Изменить фото', CONFIRM_CHANGE_PHOTOS),
      ],
    ]);
    return { caption, buttons };
  }

  /**
   * Commit a confirmed pending product: perform the database writes, then send a
   * simple success message (the preview already showed the full product). No-op
   * with a notice if there is nothing pending. Uploaded assets are kept.
   */
  private async commitPending(ctx: Context, tgUserId: number): Promise<void> {
    // Take the session (without deleting its Cloudinary assets — the saved
    // product keeps them). Consuming it up front also makes a double-tap safe.
    const session = this.takePending(tgUserId);
    if (!session) {
      await ctx.reply(
        '⌛ Нет товара для подтверждения (возможно, время истекло). Нажмите /start, чтобы начать заново.',
      );
      return;
    }

    const { sellerId, metadata, title, vehicleCategory, processedUrls, price } =
      session;

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
        mainCategory: classification.mainCategory,
        vehicleCategory,
        partBrand: classification.make,
        originRegion: classification.originRegion,
        isOem: classification.isOem,
        isGm: classification.isGm,
        oemNumber,
        partNumberType,
      };

      const product = await this.prisma.product.upsert({
        where: { gmNumber: gmKey },
        update: {
          title,
          description: metadata.description,
          imageUrl: primaryUrl,
          isUniversal: metadata.isUniversal,
          ...classifiedFields,
        },
        create: {
          gmNumber: metadata.gm_number,
          title,
          description: metadata.description,
          imageUrl: primaryUrl,
          isUniversal: metadata.isUniversal,
          ...classifiedFields,
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

      // The product write succeeded, so finalize the backing draft: mark it PUBLISHED
      // (so the TTL sweep never touches it — critical because the sweep also covers
      // READY_FOR_PREVIEW) and delete the STORED ORIGINALS (the processed URLs are now
      // the product's images and are kept). Best-effort: a failure here must NOT fail
      // the already-committed product.
      await this.finalizePublishedDraft(session.draftId, sellerId);

      // The preview already served as the confirmation UI — the success message
      // only needs to confirm the write completed. Do not resend product details.
      await ctx.reply(
        '✅ Товар успешно добавлен.\nНажмите /start, чтобы добавить следующий товар.',
      );
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
      await ctx.reply(
        `⚠️ Произошла ошибка при добавлении товара.\n\`${errMsg}\``,
        { parse_mode: 'Markdown' },
      );
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
