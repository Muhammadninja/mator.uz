import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SellerStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import axios from 'axios';
import { Context, Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { ParseOutcome } from '../ai/part-parser.types';
import { PartParserService } from '../ai/part-parser.service';
import { lookupOemCompatibility } from '../ai/oem-compatibility.service';
import { splitPartNumber } from '../ai/part-number';
import { classifyPart } from '../ai/part-classifier';
import { extractPriceFromText } from '../ai/rule-based-parser';
import { ImageEnhanceService } from '../ai/image-enhance.service';
import { PrismaService } from '../prisma/prisma.service';
import { SellersService } from '../sellers/sellers.service';
import { CloudinaryService, UploadedImage } from '../cloudinary/cloudinary.service';
import { CatalogProjectionService } from '../catalog/projection/catalog-projection.service';
import { MediaGroupBuffer } from './media-group-buffer';
import { persistVehicleLinks } from './vehicle-links';

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
export function resolveImageConcurrency(raw: string | undefined, logger: Logger): number {
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

// Inline-button callback payloads for the confirmation step.
const CONFIRM_ADD = 'product:add';
const CONFIRM_CANCEL = 'product:cancel';

/**
 * A fully-processed listing awaiting the seller's confirmation. Everything
 * expensive (parse, vehicle detection, image processing/upload, price) is
 * already done; only the final database write is deferred to confirmation.
 */
interface PendingProduct {
  sellerId: number;
  tgUserId: number;
  metadata: ParseOutcome;
  /** Validated non-null title (guaranteed by the guard in handleListing). */
  title: string;
  processedUrls: string[];
  /** Cloudinary public_ids of the uploaded preview assets, for cleanup on
   *  cancel/expiry/replacement (kept on successful confirmation). */
  publicIds: string[];
  price: Decimal;
  expiry: NodeJS.Timeout;
}

/**
 * Last-resort price extraction from the raw caption, used ONLY when the main
 * parser (PartParserService) returns a null price. It delegates to the SAME
 * shared parsePrice used everywhere else, so a thousands-grouped price like
 * "130.000" resolves to 130000 here too — this path previously used a private
 * regex that stopped at the dot ("130.000 сум" → 130) and lacked the currency
 * variants / unrelated-number guards, silently corrupting fallback prices.
 *
 * extractPriceFromText finds the number next to a currency word (or a safe bare
 * number), ignoring GM codes / phones / years / mileage, and applies the shared
 * parsePrice (thousands/decimal rules + currency stripping). Returns Decimal(0)
 * when no price can be found, preserving the previous "never throw, default to
 * 0" contract for the caller.
 */
export function extractPriceFallback(text: string): Decimal {
  const value = extractPriceFromText(text);
  return value !== null ? new Decimal(value) : new Decimal(0);
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
  // Initialized in the constructor (needs `this.prisma` for the OEM lookup).
  private readonly partParser: PartParserService;

  // Buffer for in-flight album uploads. `ctx` for the flush is captured per
  // group via the closure below (the latest ctx of the album is sufficient —
  // all updates in an album come from the same chat).
  private mediaBuffer!: MediaGroupBuffer;
  private readonly groupCtx = new Map<string, Context>();

  // One pending confirmation per Telegram user, keyed by tgUserId. Holds the
  // fully-processed listing until the seller presses "Добавить товар".
  private readonly pending = new Map<number, PendingProduct>();

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
    // Compatibility from an OEM number is resolved ONLY through the verified
    // internal database; the parser is given a lookup bound to Prisma. No match
    // → no compatibility (never inferred from the number or the LLM).
    this.partParser = new PartParserService(undefined, (oem) =>
      lookupOemCompatibility(this.prisma, oem),
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
        if (ctx) void this.handleListing(ctx, group.tgUserId, group.fileIds, group.caption);
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
    for (const session of this.pending.values()) clearTimeout(session.expiry);
    this.pending.clear();
    this.bot?.stop('SIGTERM');
  }

  private registerHandlers() {
    this.bot.start(async (ctx) => {
      const from = ctx.from;
      if (!from) return;

      const seller = await this.sellers.upsertFromBot(
        BigInt(from.id),
        from.username ?? from.first_name,
      );

      if (seller.status === SellerStatus.ACTIVE) {
        await ctx.reply('✅ Добро пожаловать! Ваш аккаунт активен. Отправьте фото детали с подписью (можно до 10 фото одним альбомом).');
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

    this.bot.on(message('photo'), async (ctx: Context) => {
      const msg = ctx.message;
      if (!msg || !('photo' in msg)) return;
      const from = msg.from;
      if (!from) return;

      // Highest-resolution rendition of this photo.
      const bestPhoto = msg.photo[msg.photo.length - 1];
      const caption = 'caption' in msg ? (msg.caption ?? null) : null;
      const groupId = 'media_group_id' in msg ? msg.media_group_id : undefined;

      if (groupId) {
        // Capture the latest ctx for this user's album; the buffer flushes it.
        this.groupCtx.set(String(from.id), ctx);
        this.mediaBuffer.add(groupId, bestPhoto.file_id, caption, from.id);
        return;
      }

      // Single photo — process immediately as a one-image listing.
      await this.handleListing(ctx, from.id, [bestPhoto.file_id], caption);
    });

    // Confirmation buttons on the preview message.
    this.bot.action(CONFIRM_ADD, async (ctx) => {
      await ctx.answerCbQuery();
      // Remove the keyboard first so a second tap can't re-trigger the action.
      await this.removePreviewKeyboard(ctx);
      const from = ctx.from;
      if (from) await this.commitPending(ctx, from.id);
    });

    this.bot.action(CONFIRM_CANCEL, async (ctx) => {
      await ctx.answerCbQuery();
      // Remove the keyboard first so a second tap can't re-trigger the action.
      await this.removePreviewKeyboard(ctx);
      const from = ctx.from;
      // Delete the uploaded preview assets before dropping the session.
      if (from) await this.discardPending(from.id);
      await ctx.reply('❌ Добавление товара отменено.\nОтправьте фото и подпись заново, чтобы добавить другой товар.');
    });
  }

  /**
   * Strip the inline keyboard from the preview message (the one that carried the
   * pressed button) without deleting the message. Best-effort: if the edit fails
   * — e.g. the keyboard was already removed by an earlier tap, or the message is
   * too old — the error is logged and swallowed so the action still proceeds.
   */
  private async removePreviewKeyboard(ctx: Context): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch (err) {
      this.logger.debug(
        `Could not remove preview keyboard: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Listing pipeline (1..N images, one caption) ─────────────────────────────
  private async handleListing(
    ctx: Context,
    tgUserId: number,
    fileIds: string[],
    caption: string | null,
  ) {
    // Seller gate.
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

    if (!caption || caption.trim() === '') {
      await ctx.reply('❌ Пожалуйста, добавьте подпись к фото с названием детали, номером и ценой.');
      return;
    }

    const images = fileIds.slice(0, MAX_IMAGES_PER_LISTING);

    // AI processing can take up to ~30 s, so tell the seller to wait
    // BEFORE we start (the next step — the preview — only appears once processing
    // finishes). Best-effort: a failed notice must not abort the upload, so it is
    // logged and swallowed.
    try {
      await ctx.reply('⏳ Пожалуйста, подождите. Обработка загруженных фото может занять до 30 секунд.');
    } catch (err) {
      this.logger.debug(
        `Could not send processing notice: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      // Parse the caption once and process every image (album order preserved)
      // concurrently: caption parsing and image processing are independent, so
      // running them together hides the parse latency (notably the AI fallback)
      // behind the image pipeline instead of stacking it before.
      const [metadata, uploaded] = await Promise.all([
        this.partParser.parse(caption),
        this.processImages(images),
      ]);
      this.logger.log(
        `Parsed via ${metadata.source} (confidence=${metadata.confidence}) — ` +
        `title="${metadata.title ?? '∅'}", images=${images.length}`,
      );

      const processedUrls = uploaded.map((u) => u.url);
      const publicIds = uploaded.map((u) => u.publicId);

      // Title guard now runs after processing (parse no longer gates it), so any
      // images already uploaded on a rejected title must be cleaned up to avoid
      // orphaned Cloudinary assets.
      if (!metadata.title || metadata.title.length < 3) {
        if (publicIds.length > 0) await this.cloudinary.deleteAssets(publicIds);
        await ctx.reply(
          '❌ Не удалось распознать название детали. Опишите товар подробнее:\n' +
          '_Пример: Фильтр масляный Cobalt Gentra 96535062 25000 сум_',
          { parse_mode: 'Markdown' },
        );
        return;
      }

      if (uploaded.length === 0) {
        await ctx.reply('⚠️ Не удалось обработать ни одно изображение. Попробуйте ещё раз.');
        return;
      }

      const price =
        metadata.price !== null ? new Decimal(metadata.price) : extractPriceFallback(caption);

      // Everything is processed. Instead of writing to the DB now, stash the
      // result as a pending confirmation and show the seller a preview with
      // Add / Cancel buttons. The DB write happens in commitPending().
      // `metadata.title` is non-null here (validated by the guard above).
      this.setPending(ctx, {
        sellerId: seller.id,
        tgUserId,
        metadata,
        title: metadata.title,
        processedUrls,
        publicIds,
        price,
      });

      await this.sendPreview(ctx, metadata, processedUrls, price);
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error
          ? error.message
          : typeof error === 'object'
            ? JSON.stringify(error)
            : String(error);
      this.logger.error(`Pipeline error: ${errMsg}`, error instanceof Error ? error.stack : undefined);
      await ctx.reply(`⚠️ Произошла ошибка при обработке товара.\n\`${errMsg}\``, { parse_mode: 'Markdown' });
    }
  }

  // ── Pending confirmation session ────────────────────────────────────────────
  /**
   * Store (or replace) the single pending confirmation for a user. If one was
   * already pending, it is discarded — its uploaded Cloudinary assets are
   * deleted — and the user is told the previous draft was replaced. Sessions
   * expire automatically after CONFIRMATION_TTL_MS (also deleting their assets).
   */
  private setPending(ctx: Context, draft: Omit<PendingProduct, 'expiry'>): void {
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
    processedUrls: string[],
    price: Decimal,
  ): Promise<void> {
    const vehicle = formatVehicleLine(metadata);
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
      const media = processedUrls.slice(0, MAX_IMAGES_PER_LISTING).map((url) => ({
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
      await ctx.reply('⌛ Нет товара для подтверждения (возможно, время истекло). Отправьте фото и подпись заново.');
      return;
    }

    const { sellerId, metadata, title, processedUrls, price } = session;

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

      // Classify the listing (title + description, RU/UZ/EN) into the stored
      // catalog attributes: main/vehicle category (always assigned) and region of
      // origin. The OEM/GM flags come EXCLUSIVELY from `partNumberType` (the
      // single label rule), passed in — not re-scanned from text. Persisted on
      // the Product and later projected into the buyer catalog for filtering.
      const classification = classifyPart(title, metadata.description, partNumberType);
      const classifiedFields = {
        mainCategory: classification.mainCategory,
        vehicleCategory: classification.vehicleCategory,
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
      await this.prisma.productImage.deleteMany({ where: { productId: product.id } });
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
      await ctx.reply('✅ Товар успешно добавлен.\nОтправьте фото и подпись следующего товара, чтобы добавить ещё.');
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error
          ? error.message
          : typeof error === 'object'
            ? JSON.stringify(error)
            : String(error);
      this.logger.error(`Commit error: ${errMsg}`, error instanceof Error ? error.stack : undefined);
      await ctx.reply(`⚠️ Произошла ошибка при добавлении товара.\n\`${errMsg}\``, { parse_mode: 'Markdown' });
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

    const workers = Array.from({ length: Math.min(this.imageConcurrency, fileIds.length) }, worker);
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
      const cleaned = await this.imageEnhance.removeBackground(Buffer.from(response.data));
      return await this.cloudinary.uploadBuffer(cleaned);
    } catch (err) {
      this.logger.warn(
        `Skipping one image (${fileId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
