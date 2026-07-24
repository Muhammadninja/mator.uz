import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
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
import { QueueService } from '../queue/queue.service';
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
  beginProcessing,
  beginQuestionnaire,
  backToPhotos,
  goBack,
  changePhotos,
  hasProcessedPhotos,
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
// An idle wizard session expires after the same inactivity window. The timer is
// SLIDING: every user action re-arms it, so only genuine inactivity triggers
// cleanup. A session that carries processed photos deletes its Cloudinary assets
// on expiry; a plain one is simply dropped.
const WIZARD_SESSION_TTL_MS = CONFIRMATION_TTL_MS;
// PARALLEL flow: how long a DB-backed draft lives before the cleanup sweep expires
// it — and, equivalently, the window in which /start offers to resume it. Default
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
  /** PARALLEL flow only: the backing draft. On confirm the draft is marked
   *  PUBLISHED and its STORED-ORIGINAL assets are cleaned up (the processed URLs
   *  become the product's, so they are kept). undefined for the legacy flow. */
  draftId?: string;
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
 * Rebuild a WizardSession from a pending draft so the seller can reopen the
 * wizard from the preview ("⬅️ Назад" / "🖼 Изменить фото") without re-entering
 * anything. Every field is restored from the draft that produced the preview —
 * a wizard listing always has exactly one (brand, model) pair, so brand/model
 * come from that pair. The processed photos are carried over too (reused on a
 * text/price edit; cleared by the caller when the seller replaces them). The
 * `step` is set by the caller (PRICE to edit text/price, PHOTOS to replace).
 */
export function buildSessionFromPending(
  pending: PendingProduct,
): WizardSession {
  const { metadata } = pending;
  const vehicle = metadata.vehicles[0];
  return {
    step: WizardStep.PRICE,
    // Reopening from the preview is a LEGACY-style edit: the photos are already
    // processed and reused verbatim, so the synchronous PRICE→PHOTOS path applies
    // regardless of which flow originally created the listing. No draft is involved.
    flow: 'legacy',
    draftId: null,
    brand: vehicle?.brand ?? metadata.brand ?? null,
    model: vehicle?.model ?? metadata.models[0] ?? null,
    category: pending.vehicleCategory,
    title: pending.title,
    description: metadata.description,
    partNumberType: metadata.part_number_type ?? 'UNKNOWN',
    partNumber: metadata.gm_number,
    // Decimal → number: the wizard collects price as an integer sum; the draft's
    // Decimal has no fractional part (Stock priceUzs came straight from it).
    price: pending.price.toNumber(),
    processedUrls: [...pending.processedUrls],
    publicIds: [...pending.publicIds],
  };
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf;

  // When true, /start uses the PHOTOS-FIRST parallel flow (images process via
  // BullMQ while the seller answers the questionnaire). When false, the original
  // synchronous photos-LAST flow runs unchanged. Flag-gated for staged rollout /
  // instant rollback (PARALLEL_DRAFT_FLOW).
  private readonly parallelFlow: boolean;

  // PARALLEL flow draft TTL (ms), resolved once from DRAFT_TTL_HOURS.
  private readonly draftTtlMs: number;

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

  // Sliding inactivity timers for EVERY wizard session, keyed by tgUserId (at
  // most one per user). Armed when a session is created and re-armed on every
  // user action (see touchSession); on expiry the session is removed — and, if
  // it carries processed photos, its Cloudinary assets are deleted first. This
  // is the single TTL mechanism for wizard sessions.
  private readonly sessionExpiry = new Map<number, NodeJS.Timeout>();

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
    private readonly imageEnhance: ImageEnhanceService,
    private readonly drafts: ProductDraftService,
    private readonly draftCoordinator: DraftCoordinator,
    private readonly queue: QueueService,
    private readonly telemetry: DraftTelemetry,
  ) {
    this.imageConcurrency = resolveImageConcurrency(
      this.config.get<string>('IMAGE_CONCURRENCY'),
      this.logger,
    );
    this.parallelFlow =
      this.config.get<string>('PARALLEL_DRAFT_FLOW') === 'true';
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
    for (const timer of this.sessionExpiry.values()) clearTimeout(timer);
    this.sessionExpiry.clear();
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
        // A restart abandons any in-progress session: drop it (and its inactivity
        // timer), deleting any carried-over Cloudinary photos so they don't leak.
        // The fresh session's own timer is armed by sendStepPrompt below.
        await this.discardSessionPhotos(from.id);
        if (this.parallelFlow) {
          await this.startParallelProductCreation(ctx, from.id, seller.id);
        } else {
          const session = this.wizard.start(from.id);
          await this.sendStepPrompt(ctx, session);
        }
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
      // PARALLEL flow: persist the answered field to the draft and, when the
      // questionnaire is finished, hand off to the coordinator (rendezvous).
      if (result.status === 'ok' && session.flow === 'parallel') {
        await this.handleParallelFormAdvance(ctx, from.id, session);
        return;
      }
      // Reuse path: a text/price edit on a session returned from the preview
      // (photos already processed) advances to PHOTOS — but those photos must
      // NOT be re-uploaded. Rebuild the preview directly from the existing
      // assets instead of asking for photos again (no AI/Cloudinary work).
      if (
        result.status === 'ok' &&
        session.step === WizardStep.PHOTOS &&
        hasProcessedPhotos(session)
      ) {
        await this.rebuildPreviewFromSession(ctx, from.id, session);
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
        // fresh /start is always required to begin the next listing). Cancel any
        // lingering inactivity timer so it can't fire after the flow ended.
        this.clearSessionExpiry(from.id);
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
        this.clearSessionExpiry(from.id);
        this.wizard.delete(from.id);
      }
      await ctx.reply(
        '❌ Добавление товара отменено.\nНажмите /start, чтобы начать заново.',
      );
    });

    // "⬅️ Назад" on the preview: reopen the wizard at the PRICE step to edit
    // text/price, REUSING the already-processed photos (no image re-processing).
    this.bot.action(CONFIRM_BACK, async (ctx) => {
      await ctx.answerCbQuery();
      await this.removeInlineKeyboard(ctx);
      const from = ctx.from;
      if (from) await this.reopenFromPreview(ctx, from.id, WizardStep.PRICE);
    });

    // "🖼 Изменить фото" on the preview: reopen the wizard at the PHOTOS step and
    // discard the old photos so the seller uploads new ones (which re-run the
    // full pipeline). This is the ONLY preview path that deletes/regenerates
    // images — text/price edits via "⬅️ Назад" never touch them.
    this.bot.action(CONFIRM_CHANGE_PHOTOS, async (ctx) => {
      await ctx.answerCbQuery();
      await this.removeInlineKeyboard(ctx);
      const from = ctx.from;
      if (from) await this.reopenFromPreview(ctx, from.id, WizardStep.PHOTOS);
    });

    // ── PARALLEL flow: /start resume prompt ─────────────────────────────────
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
      // Discard the old draft (assets + jobs) and begin a brand-new parallel flow.
      await this.cancelActiveDraft(from.id);
      await this.startParallelProductCreation(ctx, from.id, seller.id);
    });

    // ── PARALLEL flow: image-failure recovery ───────────────────────────────
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
  // PARALLEL flow (photos-first, images processed in the background via BullMQ).
  // Only reachable when PARALLEL_DRAFT_FLOW is on. The legacy synchronous flow
  // above is untouched.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Entry point for the parallel flow's /start. If a resumable draft exists (a
   * CREATING draft within its TTL), offer to continue or start over; otherwise
   * begin a fresh session at PHOTOS_FIRST and ask for photos first.
   */
  private async startParallelProductCreation(
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
    const session = this.wizard.startParallel(tgUserId);
    await this.sendStepPrompt(ctx, session);
    this.touchSession(tgUserId);
  }

  /**
   * PARALLEL flow — photos arrived first. Create the DB draft with one PROCESSING
   * image row per photo, enqueue a job per row (the worker fetches + processes each
   * in the background), advance the wizard to BRAND, and start the questionnaire.
   * NO network happens here: only the tgFileId is stored — the worker fetches the
   * original itself (phase A). So the first question appears with zero upload wait.
   */
  private async handleParallelPhotos(
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

    // Enqueue one job per image row (deterministic jobId → idempotent).
    for (const img of draft.images) {
      try {
        const job = await this.queue.enqueueImage({
          draftId: draft.id,
          imageId: img.id,
        });
        if (job.id) await this.drafts.setImageJobId(img.id, job.id);
        this.telemetry.event('image.queued', {
          draftId: draft.id,
          imageId: img.id,
          sellerId: seller.id,
          jobId: job.id,
        });
        this.telemetry.metric(DraftMetric.IMAGE_QUEUED, {
          draftId: draft.id,
          imageId: img.id,
          jobId: job.id,
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
   * PARALLEL flow — a questionnaire step was answered. Persist the answered fields
   * to the draft (so nothing is lost on restart/expiry), then either continue the
   * questionnaire or, once it is finished (QUESTIONNAIRE_DONE), hand off to the
   * coordinator. If the images are already done the coordinator sends the preview
   * immediately (its ready_for_preview event); otherwise the seller sees a short
   * holding message and the preview follows automatically when the last image lands.
   */
  private async handleParallelFormAdvance(
    ctx: Context,
    tgUserId: number,
    session: WizardSession,
  ): Promise<void> {
    if (!session.draftId) {
      // Defensive: a parallel session must have a draft by the time the
      // questionnaire runs. If not, restart cleanly.
      this.logger.error(
        `Parallel session for ${tgUserId} has no draftId — restarting.`,
      );
      await this.discardSessionPhotos(tgUserId);
      await ctx.reply(START_HINT);
      return;
    }

    // Persist the current field snapshot (idempotent; cheap). Re-arm the TTL.
    this.touchSession(tgUserId);
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

    // Questionnaire finished. The form's inactivity timer no longer applies (the
    // draft's own TTL governs from here); the wizard session is consumed — the
    // coordinator/pending machinery owns the flow now.
    this.clearSessionExpiry(tgUserId);
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

  // ── PARALLEL flow: domain-event listeners (the worker↔bot seam) ─────────────
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
   * PARALLEL flow — resume the seller's in-progress draft on /start. Restore a
   * wizard session at the draft's saved formStep, then re-prompt. Images keep
   * processing in the background (their jobs are still queued), so the rendezvous
   * will fire normally. If the form was already finished, nudge to wait / re-check.
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

    // Rebuild the wizard session from the draft's saved state.
    const session = this.wizard.startParallel(tgUserId);
    session.draftId = draft.id;
    session.step = (draft.formStep as WizardStep) ?? WizardStep.BRAND;
    session.brand = draft.brand;
    session.model = draft.model;
    session.category = draft.category;
    session.title = draft.title;
    session.description = draft.description;
    session.partNumberType = draft.partNumberType;
    session.partNumber = draft.partNumber;
    session.price = draft.priceUzs ? draft.priceUzs.toNumber() : null;
    this.wizard.restore(tgUserId, session);
    this.touchSession(tgUserId);

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
        const job = await this.queue.reenqueueImage({
          draftId: draft.id,
          imageId: img.id,
        });
        if (job.id) await this.drafts.setImageJobId(img.id, job.id);
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
        // reenqueueImage (not enqueueImage): the previous FAILED job is still in
        // Redis under the same deterministic id, so a plain add() would be a no-op.
        const job = await this.queue.reenqueueImage({
          draftId: draft.id,
          imageId: img.id,
        });
        if (job.id) await this.drafts.setImageJobId(img.id, job.id);
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
   * PARALLEL flow — cancel the seller's in-progress draft: delete its Cloudinary
   * assets, remove any unfinished image jobs, and mark it CANCELLED (versioned, so
   * a concurrent transition is respected). Also clears any wizard session/timer.
   */
  private async cancelActiveDraft(tgUserId: number): Promise<void> {
    this.clearSessionExpiry(tgUserId);
    this.wizard.delete(tgUserId);
    const seller = await this.sellers.findByTgId(BigInt(tgUserId));
    if (!seller) return;
    const draft = await this.drafts.findResumable(seller.id);
    if (!draft) return;

    const publicIds = await this.drafts.collectPublicIds(draft.id);
    if (publicIds.length > 0) await this.cloudinary.deleteAssets(publicIds);
    for (const img of draft.images) {
      if (img.jobId) {
        try {
          await this.queue.removeImageJob(img.jobId);
        } catch {
          // already gone / active — ignore.
        }
      }
    }
    await this.drafts.tryTransition(
      draft.id,
      'CREATING',
      'CANCELLED',
      draft.version,
    );
  }

  /**
   * Reopen the wizard from the preview's "⬅️ Назад" / "🖼 Изменить фото" buttons.
   * Consumes the pending draft (WITHOUT deleting its assets up front) and rebuilds
   * a WizardSession from it, so no new listing is created — the existing draft's
   * data is restored verbatim.
   *
   *  - `target === PRICE`  → edit text/price; the processed photos are carried
   *    into the session and reused, so no AI/Cloudinary work re-runs.
   *  - `target === PHOTOS` → replace photos; the old Cloudinary assets are
   *    deleted and the session's photo references cleared, so the next upload
   *    re-runs the pipeline.
   *
   * A missing/expired pending draft is reported and left alone (nothing to reopen).
   */
  private async reopenFromPreview(
    ctx: Context,
    tgUserId: number,
    target: WizardStep.PRICE | WizardStep.PHOTOS,
  ): Promise<void> {
    // Take the draft but KEEP its assets (takePending does not delete them):
    // going back to PRICE must preserve the processed photos for reuse.
    const pending = this.takePending(tgUserId);
    if (!pending) {
      await ctx.reply(
        '⌛ Нет товара для редактирования (возможно, время истекло). Нажмите /start, чтобы начать заново.',
      );
      return;
    }

    const session = buildSessionFromPending(pending);
    if (target === WizardStep.PHOTOS) {
      // Replacing photos: drop the carried-over assets from the session and
      // delete them from Cloudinary, then land on PHOTOS to await a fresh upload.
      changePhotos(session);
      if (pending.publicIds.length > 0) {
        await this.cloudinary.deleteAssets(pending.publicIds);
      }
    } else {
      // Editing text/price: the processed photos stay on the session for reuse.
      session.step = WizardStep.PRICE;
    }

    this.wizard.restore(tgUserId, session);
    // sendStepPrompt arms the sliding inactivity TTL for the restored session,
    // so abandoned edits (with or without photos) are cleaned up like any other.
    await this.sendStepPrompt(ctx, session);
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
    // PARALLEL flow: persist the answered field to the draft and, when the
    // questionnaire finishes, hand off to the coordinator (rendezvous).
    if (session.flow === 'parallel') {
      await this.handleParallelFormAdvance(ctx, from.id, session);
      return;
    }
    await this.sendStepPrompt(ctx, session);
  }

  /** Send the prompt (text + inline keyboard) asking for the session's current step. */
  private async sendStepPrompt(
    ctx: Context,
    session: WizardSession,
  ): Promise<void> {
    // Every prompt is the bot's reply to a user action inside the wizard, so
    // this is the single place the sliding inactivity TTL is (re-)armed — one
    // mechanism, extended on every step. `ctx.from` is present for message /
    // callback updates (all wizard entry points); guard defensively regardless.
    const tgUserId = ctx.from?.id;
    if (tgUserId !== undefined) this.touchSession(tgUserId);
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
    // PARALLEL flow: photos arrive FIRST (the PHOTOS_FIRST step). Accept them, kick
    // off background processing, and start the questionnaire — handled separately.
    if (
      session.flow === 'parallel' &&
      session.step === WizardStep.PHOTOS_FIRST
    ) {
      await this.handleParallelPhotos(ctx, tgUserId, session, fileIds);
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

      // Freshly processed photos become the session's assets, then the shared
      // finalize step builds the pending draft and sends the preview.
      session.processedUrls = uploaded.map((u) => u.url);
      session.publicIds = uploaded.map((u) => u.publicId);
      await this.finalizeToPreview(ctx, tgUserId, session, seller.id);
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

  /**
   * Rebuild the preview from a session returned to via "⬅️ Назад" after a
   * text/price edit — the photos are ALREADY processed and stored on the session,
   * so this runs NO image pipeline. Re-gates the seller (a cheap DB read; status
   * may have changed), then hands off to the shared finalize step. On an empty
   * photo set (defensive) it falls back to asking for photos again.
   */
  private async rebuildPreviewFromSession(
    ctx: Context,
    tgUserId: number,
    session: WizardSession,
  ): Promise<void> {
    if (!hasProcessedPhotos(session)) {
      // Nothing to reuse — behave like a normal PHOTOS step.
      await this.sendStepPrompt(ctx, session);
      return;
    }
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
    await this.finalizeToPreview(ctx, tgUserId, session, seller.id);
  }

  /**
   * Shared tail of the two paths that reach the preview: assemble the listing
   * metadata from the wizard's explicit inputs, store the pending confirmation
   * (carrying the session's already-processed photos), consume the wizard
   * session, and send the preview. Runs NO image processing — its inputs are the
   * session's stored `processedUrls` / `publicIds`, whether freshly uploaded
   * (handleWizardPhotos) or reused on a text/price edit (rebuildPreviewFromSession).
   *
   * The FSM guarantees every prior field is filled before PHOTOS; this asserts it
   * defensively and restarts the wizard if not (matching handleWizardPhotos).
   */
  private async finalizeToPreview(
    ctx: Context,
    tgUserId: number,
    session: WizardSession,
    sellerId: number,
  ): Promise<void> {
    const { brand, model, category, title, price } = session;
    if (
      brand === null ||
      model === null ||
      category === null ||
      title === null ||
      price === null
    ) {
      this.logger.error(
        `Wizard session for ${tgUserId} reached the preview with missing fields — restarting.`,
      );
      const fresh = this.wizard.start(tgUserId);
      await this.sendStepPrompt(ctx, fresh);
      return;
    }

    // `vehicles` carries exactly the selected (brand, model) pair, so
    // persistence/preview behave as before — no caption parsing.
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
      `Wizard listing by ${tgUserId}: "${title}" (${brand} ${model}), images=${session.processedUrls.length}`,
    );

    const processedUrls = session.processedUrls;
    const priceDecimal = new Decimal(price);

    this.setPending(ctx, {
      sellerId,
      tgUserId,
      metadata,
      title,
      vehicleCategory: category,
      processedUrls,
      publicIds: session.publicIds,
      price: priceDecimal,
    });

    // The wizard's job is done — the pending confirmation owns the flow (and its
    // own TTL) now, so cancel the session's inactivity timer to avoid a double
    // lifetime that would delete the assets now held by the pending draft.
    this.clearSessionExpiry(tgUserId);
    // deleteIf: if the seller restarted /start meanwhile, keep THAT session.
    this.wizard.deleteIf(tgUserId, session);

    await this.sendPreview(
      ctx,
      metadata,
      category,
      processedUrls,
      priceDecimal,
    );
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
    const replaced = this.pending.has(draft.tgUserId);
    this.storePending(draft);
    if (replaced) {
      void ctx.reply('♻️ Предыдущий неподтверждённый товар заменён новым.');
    }
  }

  /**
   * ctx-free core of setPending: discard any existing pending (deleting its
   * assets), arm the expiry, and store the new one. Used by both the legacy path
   * (via setPending, which adds the "replaced" chat notice) and the parallel path
   * (which is driven by a domain event and has no ctx). Returns whether a previous
   * pending was replaced, so an out-of-band caller can notify if it wants to.
   */
  private storePending(draft: Omit<PendingProduct, 'expiry'>): boolean {
    const replaced = this.pending.has(draft.tgUserId);
    if (replaced) {
      void this.discardPending(draft.tgUserId); // deletes the replaced draft's assets
    }
    const expiry = setTimeout(() => {
      // Auto-expiry: drop the session and clean up its uploaded assets.
      void this.discardPending(draft.tgUserId);
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
   * Delete any Cloudinary assets held by the user's WIZARD session (as opposed
   * to a pending draft) and drop the session entirely. A session carries photos
   * only after it was reopened from the preview via "⬅️ Назад"; if such a
   * session is abandoned (e.g. the seller sends /start, or the TTL fires) its
   * assets would otherwise leak. Best-effort and idempotent. Always cancels the
   * inactivity timer so it can't fire again on the removed session.
   */
  private async discardSessionPhotos(tgUserId: number): Promise<void> {
    this.clearSessionExpiry(tgUserId);
    const session = this.wizard.get(tgUserId);
    this.wizard.delete(tgUserId);
    if (session && session.publicIds.length > 0) {
      await this.cloudinary.deleteAssets(session.publicIds);
    }
  }

  /**
   * Start or re-arm the SLIDING inactivity timer for the user's wizard session.
   * Called when a session is created and on every user action (via
   * sendStepPrompt), so the TTL only elapses on genuine inactivity. On expiry
   * the session is removed and — if it holds processed photos — its Cloudinary
   * assets are deleted first (a photo-less session hits no Cloudinary at all).
   * Any existing timer for the user is replaced.
   */
  private touchSession(tgUserId: number): void {
    this.clearSessionExpiry(tgUserId);
    const timer = setTimeout(() => {
      this.sessionExpiry.delete(tgUserId);
      const session = this.wizard.get(tgUserId);
      this.wizard.delete(tgUserId);
      // Only a session that actually carries photos touches Cloudinary.
      if (session && session.publicIds.length > 0) {
        void this.cloudinary.deleteAssets(session.publicIds);
      }
    }, WIZARD_SESSION_TTL_MS);
    timer.unref?.(); // don't keep the process alive for an idle session
    this.sessionExpiry.set(tgUserId, timer);
  }

  /** Cancel and forget the inactivity timer for a user's wizard session, if any. */
  private clearSessionExpiry(tgUserId: number): void {
    const timer = this.sessionExpiry.get(tgUserId);
    if (timer) {
      clearTimeout(timer);
      this.sessionExpiry.delete(tgUserId);
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
    const { caption, buttons } = this.buildPreview(
      metadata,
      vehicleCategory,
      price,
    );
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
   * ctx-free preview send used by the PARALLEL flow's ready_for_preview event (the
   * form may have finished before the images, so there is no live ctx — we send to
   * the seller's chat id). Mirrors sendPreview exactly but via bot.telegram.
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

      // PARALLEL flow: the product write succeeded, so finalize the backing draft.
      // Mark it PUBLISHED (so the TTL sweep never touches it — critical now that the
      // sweep also covers READY_FOR_PREVIEW) and delete the STORED ORIGINALS (the
      // processed URLs are now the product's images and are kept). Best-effort: a
      // failure here must NOT fail the already-committed product.
      if (session.draftId) {
        await this.finalizePublishedDraft(session.draftId, sellerId);
      }

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
