import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PartVehicleCategory, SellerStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import axios from 'axios';
import { Context, Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { ParseOutcome } from '../ai/part-parser.types';
import { splitPartNumber } from '../ai/part-number';
import { classifyPart } from '../ai/part-classifier';
import { ImageEnhanceService } from '../ai/image-enhance.service';
import { PrismaService } from '../prisma/prisma.service';
import { SellersService } from '../sellers/sellers.service';
import {
  CloudinaryService,
  UploadedImage,
} from '../cloudinary/cloudinary.service';
import { CatalogProjectionService } from '../catalog/projection/catalog-projection.service';
import { MediaGroupBuffer } from './media-group-buffer';
import { persistVehicleLinks } from './vehicle-links';
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
  beginProcessing,
  backToPhotos,
  stepPrompt,
} from './product-wizard';
import { WIZARD_CATEGORIES } from './wizard-catalog';

// Telegram delivers an album as N separate photo updates sharing a
// media_group_id, arriving back-to-back; only one carries the caption. We
// buffer by group id and flush after a short quiet window.
const MEDIA_GROUP_DEBOUNCE_MS = 1500;
const MAX_IMAGES_PER_LISTING = 10;
// Process album images in parallel, but bound concurrency so we don't hammer
// FLUX/Cloudinary or spike memory with many large buffers at once. The
// bound is configurable via IMAGE_CONCURRENCY; the default (5) overlaps enough
// remote waits (FLUX/Cloudinary) to keep the pool busy without risking
// rate limits or memory spikes.
const IMAGE_CONCURRENCY_DEFAULT = 5;
const IMAGE_CONCURRENCY_MIN = 1;
const IMAGE_CONCURRENCY_MAX = 10;

/**
 * Resolve the album image-processing concurrency from a raw env value. Accepts
 * an integer in [IMAGE_CONCURRENCY_MIN, IMAGE_CONCURRENCY_MAX]; anything missing,
 * non-integer, or out of range falls back to IMAGE_CONCURRENCY_DEFAULT and logs
 * a warning (except when simply unset, which is the expected default case).
 */
export function resolveImageConcurrency(
  raw: string | undefined,
  logger: Logger,
): number {
  if (raw === undefined || raw.trim() === '') return IMAGE_CONCURRENCY_DEFAULT;

  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < IMAGE_CONCURRENCY_MIN ||
    value > IMAGE_CONCURRENCY_MAX
  ) {
    logger.warn(
      `Invalid IMAGE_CONCURRENCY="${raw}" (expected an integer ` +
        `${IMAGE_CONCURRENCY_MIN}–${IMAGE_CONCURRENCY_MAX}); ` +
        `falling back to ${IMAGE_CONCURRENCY_DEFAULT}.`,
    );
    return IMAGE_CONCURRENCY_DEFAULT;
  }
  return value;
}
// A pending confirmation expires automatically after this long (10 minutes).
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

// Within this window, repeated taps on stale (old-catalog) buttons by the same
// user send the "catalog updated" text message only once. The per-tap alert
// popup (answerCbQuery) still fires every time — Telegram shows it in place and
// it does not accumulate; only the chat message is deduplicated.
const STALE_NOTICE_DEDUP_MS = 5000;

// Inline-button callback payloads for the confirmation step.
const CONFIRM_ADD = 'product:add';
const CONFIRM_CANCEL = 'product:cancel';

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
  '1️⃣ Марка автомобиля (кнопка)\n' +
  '2️⃣ Модель (кнопка)\n' +
  '3️⃣ Категория запчасти (кнопка)\n' +
  '4️⃣ Название товара (текст)\n' +
  '5️⃣ Описание — можно пропустить\n' +
  '6️⃣ Тип номера: OEM, GM или пропустить\n' +
  '7️⃣ Номер детали (если выбрали OEM/GM)\n' +
  '8️⃣ Цена в сумах\n' +
  '9️⃣ Фотографии — одно фото или альбом до 10 фото\n\n' +
  '✅ После фото бот покажет предпросмотр — проверьте и нажмите «Добавить товар».\n\n' +
  '💡 Марку и модель выбирайте только кнопками — вводить их вручную не нужно.\n' +
  '🔎 Если указать OEM или GM номер, покупателям будет намного проще найти вашу деталь через поиск.';

/**
 * A fully-processed listing awaiting the seller's confirmation. Everything
 * expensive (wizard input, image processing/upload) is already done; only the
 * final database write is deferred to confirmation.
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

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf;

  private readonly imageEnhance = new ImageEnhanceService();

  // Step-by-step product-creation wizard sessions, one per Telegram user.
  private readonly wizard = new WizardSessionStore();

  // Buffer for in-flight album uploads. `ctx` for the flush is captured per
  // group via the closure below (the latest ctx of the album is sufficient —
  // all updates in an album come from the same chat).
  private mediaBuffer!: MediaGroupBuffer;
  private readonly groupCtx = new Map<string, Context>();

  // One pending confirmation per Telegram user, keyed by tgUserId. Holds the
  // fully-processed listing until the seller presses "Добавить товар".
  private readonly pending = new Map<number, PendingProduct>();

  // Last time (ms epoch) each user was sent the "catalog updated, restart"
  // notice. Rapid repeat taps on stale buttons share one notice within
  // STALE_NOTICE_DEDUP_MS instead of piling up identical messages.
  private readonly staleNoticeSentAt = new Map<number, number>();

  // Album image-processing concurrency, resolved once from IMAGE_CONCURRENCY.
  private readonly imageConcurrency: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sellers: SellersService,
    private readonly cloudinary: CloudinaryService,
    private readonly catalogProjection: CatalogProjectionService,
  ) {
    this.imageConcurrency = resolveImageConcurrency(
      this.config.get<string>('IMAGE_CONCURRENCY'),
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
        const session = this.wizard.start(from.id);
        await this.sendStepPrompt(ctx, session);
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
      // 'ok' → prompt for the next step; 'stale' → re-prompt the current one.
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
        // Delete the uploaded preview assets before dropping the session, and
        // clear any wizard state so the flow ends fully (terminal action).
        await this.discardPending(from.id);
        this.wizard.delete(from.id);
      }
      await ctx.reply(
        '❌ Добавление товара отменено.\nНажмите /start, чтобы начать заново.',
      );
    });
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
    await this.sendStepPrompt(ctx, session);
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

  // ── Photo hand-off: wizard PHOTOS step → image pipeline → preview ──────────
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
    if (session.step !== WizardStep.PHOTOS) {
      // Photos sent too early (or while processing) — re-show what's expected.
      await this.sendStepPrompt(ctx, session);
      return;
    }

    // Seller gate at the same pipeline position as before: right before any
    // expensive processing. Status may have changed since /start.
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

    // FSM invariant: PHOTOS is only reachable once every prior step is filled.
    const { brand, model, category, title, price } = session;
    if (
      brand === null ||
      model === null ||
      category === null ||
      title === null ||
      price === null
    ) {
      this.logger.error(
        `Wizard session for ${tgUserId} reached PHOTOS with missing fields — restarting.`,
      );
      const fresh = this.wizard.start(tgUserId);
      await this.sendStepPrompt(ctx, fresh);
      return;
    }

    // At least one photo is REQUIRED before publication. An empty hand-off
    // (defensive — the single-photo and album paths always carry ≥1 file id)
    // must not advance the flow: re-ask for photos and stay on the PHOTOS step.
    const images = fileIds.slice(0, MAX_IMAGES_PER_LISTING);
    if (images.length === 0) {
      await this.sendStepPrompt(ctx, session);
      return;
    }

    // Guard against a second album racing the first while images process.
    if (beginProcessing(session).status !== 'ok') return;

    // Image processing can take up to ~30 s, so tell the seller to wait BEFORE
    // we start (the next step — the preview — only appears once processing
    // finishes). Best-effort: a failed notice must not abort the upload.
    try {
      await ctx.reply(
        '⏳ Пожалуйста, подождите. Обработка загруженных фото может занять до 30 секунд.',
      );
    } catch (err) {
      this.logger.debug(
        `Could not send processing notice: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const uploaded = await this.processImages(images);

      if (uploaded.length === 0) {
        backToPhotos(session);
        await ctx.reply(
          '⚠️ Не удалось обработать ни одно изображение. Попробуйте ещё раз.',
        );
        return;
      }

      // Assemble the listing metadata directly from the wizard's explicit
      // inputs — no caption parsing. `vehicles` carries exactly the selected
      // (brand, model) pair, so persistence/preview behave as before.
      const metadata: ParseOutcome = {
        title,
        description: session.description,
        brand,
        models: [model],
        vehicles: [{ brand, model }],
        isUniversal: false,
        gm_number: session.partNumber,
        part_number_type: session.partNumberType,
        price,
        source: 'wizard',
        confidence: 1,
      };
      this.logger.log(
        `Wizard listing by ${tgUserId}: "${title}" (${brand} ${model}), images=${uploaded.length}`,
      );

      const processedUrls = uploaded.map((u) => u.url);
      const priceDecimal = new Decimal(price);

      this.setPending(ctx, {
        sellerId: seller.id,
        tgUserId,
        metadata,
        title,
        vehicleCategory: category,
        processedUrls,
        publicIds: uploaded.map((u) => u.publicId),
        price: priceDecimal,
      });

      // The wizard's job is done — the pending confirmation owns the flow now.
      // deleteIf: if the seller restarted /start meanwhile, keep THAT session.
      this.wizard.deleteIf(tgUserId, session);

      await this.sendPreview(
        ctx,
        metadata,
        category,
        processedUrls,
        priceDecimal,
      );
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error
          ? error.message
          : typeof error === 'object'
            ? JSON.stringify(error)
            : String(error);
      this.logger.error(
        `Pipeline error: ${errMsg}`,
        error instanceof Error ? error.stack : undefined,
      );
      backToPhotos(session); // stale-safe: no-op if the session moved on
      await ctx.reply(
        `⚠️ Произошла ошибка при обработке товара.\n\`${errMsg}\``,
        { parse_mode: 'Markdown' },
      );
    }
  }

  // ── Pending confirmation session ────────────────────────────────────────────
  /**
   * Store (or replace) the single pending confirmation for a user. If one was
   * already pending, it is discarded — its uploaded Cloudinary assets are
   * deleted — and the user is told the previous draft was replaced. Sessions
   * expire automatically after CONFIRMATION_TTL_MS (also deleting their assets).
   */
  private setPending(
    ctx: Context,
    draft: Omit<PendingProduct, 'expiry'>,
  ): void {
    if (this.pending.has(draft.tgUserId)) {
      void this.discardPending(draft.tgUserId); // deletes the replaced draft's assets
      void ctx.reply('♻️ Предыдущий неподтверждённый товар заменён новым.');
    }

    const expiry = setTimeout(() => {
      // Auto-expiry: drop the session and clean up its uploaded assets.
      void this.discardPending(draft.tgUserId);
    }, CONFIRMATION_TTL_MS);
    // Don't keep the process alive just for a pending confirmation.
    expiry.unref?.();

    this.pending.set(draft.tgUserId, { ...draft, expiry });
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
   * Discard a pending session AND delete its uploaded Cloudinary assets. Used on
   * cancel, auto-expiry, and replacement. Cleanup failures are logged by
   * CloudinaryService and never throw, so the discard always completes.
   */
  private async discardPending(tgUserId: number): Promise<void> {
    const session = this.takePending(tgUserId);
    if (session && session.publicIds.length > 0) {
      await this.cloudinary.deleteAssets(session.publicIds);
    }
  }

  /**
   * Preview shown before the DB write. Distinct from the success message: it
   * asks the seller to review and carries the Add / Cancel inline buttons.
   */
  private async sendPreview(
    ctx: Context,
    metadata: ParseOutcome,
    vehicleCategory: PartVehicleCategory,
    processedUrls: string[],
    price: Decimal,
  ): Promise<void> {
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
      Markup.button.callback('✅ Добавить товар', CONFIRM_ADD),
      Markup.button.callback('❌ Отменить', CONFIRM_CANCEL),
    ]);

    // Single image → photo + caption + buttons; album → media group preview
    // followed by the caption+buttons as a separate message (media groups can't
    // carry an inline keyboard).
    try {
      if (processedUrls.length === 1) {
        await ctx.replyWithPhoto(processedUrls[0], {
          caption,
          parse_mode: 'Markdown',
          ...buttons,
        });
        return;
      }
      const media = processedUrls
        .slice(0, MAX_IMAGES_PER_LISTING)
        .map((url) => ({
          type: 'photo' as const,
          media: url,
        }));
      await ctx.replyWithMediaGroup(media);
      await ctx.reply(caption, { parse_mode: 'Markdown', ...buttons });
    } catch (err) {
      this.logger.warn(
        `Failed to send preview media, falling back to text: ${err instanceof Error ? err.message : String(err)}`,
      );
      await ctx.reply(caption, { parse_mode: 'Markdown', ...buttons });
    }
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

  /**
   * Download → image-enhance pipeline → Cloudinary for each image. Runs with a small
   * concurrency limit (images are independent) instead of fully sequentially, so
   * an album of N photos no longer takes N× the single-image latency. Album
   * order is preserved (results placed by index); a single image failing is
   * logged and skipped — the caller handles the all-failed case.
   */
  private async processImages(fileIds: string[]): Promise<UploadedImage[]> {
    const results = new Array<UploadedImage | null>(fileIds.length).fill(null);
    let next = 0;

    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= fileIds.length) return;
        results[i] = await this.processOneImage(fileIds[i]);
      }
    };

    const workers = Array.from(
      { length: Math.min(this.imageConcurrency, fileIds.length) },
      worker,
    );
    await Promise.all(workers);

    // Drop failed slots, keep album order.
    return results.filter((u): u is UploadedImage => u !== null);
  }

  /** Process a single image; returns its uploaded asset or null on failure. */
  private async processOneImage(fileId: string): Promise<UploadedImage | null> {
    try {
      const fileLink = await this.bot.telegram.getFileLink(fileId);
      const response = await axios.get<ArrayBuffer>(fileLink.href, {
        responseType: 'arraybuffer',
        timeout: 20_000,
      });
      // FLUX.2 Max (enhance → 1000×1000 product photo on a white background),
      // uploaded as-is on success. No local post-processing.
      const cleaned = await this.imageEnhance.removeBackground(
        Buffer.from(response.data),
      );
      return await this.cloudinary.uploadBuffer(cleaned);
    } catch (err) {
      this.logger.warn(
        `Skipping one image (${fileId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
