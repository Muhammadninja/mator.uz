import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SellerStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import axios from 'axios';
import { Context, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { PartParserService } from '../ai/part-parser.service';
import { PhotoroomService } from '../ai/photoroom.service';
import { PrismaService } from '../prisma/prisma.service';
import { SellersService } from '../sellers/sellers.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { MediaGroupBuffer } from './media-group-buffer';

// Telegram delivers an album as N separate photo updates sharing a
// media_group_id, arriving back-to-back; only one carries the caption. We
// buffer by group id and flush after a short quiet window.
const MEDIA_GROUP_DEBOUNCE_MS = 1500;
const MAX_IMAGES_PER_LISTING = 10;

function extractPriceFallback(text: string): Decimal {
  const currencyMatch = text.match(/(\d+)\s*(uzs|UZS|сўм|сум)/i);
  if (currencyMatch) return new Decimal(currencyMatch[1]);
  const matches = text.match(/\d+/g);
  if (!matches) return new Decimal(0);
  const candidates = matches.map(Number).filter((n) => n > 1000);
  if (candidates.length > 0) return new Decimal(Math.max(...candidates));
  return new Decimal(Math.max(...matches.map(Number)));
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf;

  private readonly photoroom = new PhotoroomService();
  private readonly partParser = new PartParserService();

  // Buffer for in-flight album uploads. `ctx` for the flush is captured per
  // group via the closure below (the latest ctx of the album is sufficient —
  // all updates in an album come from the same chat).
  private mediaBuffer!: MediaGroupBuffer;
  private readonly groupCtx = new Map<string, Context>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sellers: SellersService,
    private readonly cloudinary: CloudinaryService,
  ) {}

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
    this.bot.launch().then(() => this.logger.log('Bot started (long polling)'));
  }

  onModuleDestroy() {
    this.mediaBuffer?.clear();
    this.groupCtx.clear();
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

    try {
      // Parse the caption once; process every image through the full pipeline,
      // preserving album order.
      const metadata = await this.partParser.parse(caption);
      this.logger.log(
        `Parsed via ${metadata.source} (confidence=${metadata.confidence}) — ` +
        `title="${metadata.title ?? '∅'}", images=${images.length}`,
      );

      if (!metadata.title || metadata.title.length < 3) {
        await ctx.reply(
          '❌ Не удалось распознать название детали. Опишите товар подробнее:\n' +
          '_Пример: Фильтр масляный Cobalt Gentra 96535062 25000 сум_',
          { parse_mode: 'Markdown' },
        );
        return;
      }

      const processedUrls = await this.processImages(images);
      if (processedUrls.length === 0) {
        await ctx.reply('⚠️ Не удалось обработать ни одно изображение. Попробуйте ещё раз.');
        return;
      }

      let brandId: number | null = null;
      if (metadata.brand) {
        const brand = await this.prisma.brand.upsert({
          where: { name: metadata.brand },
          update: {},
          create: { name: metadata.brand },
        });
        brandId = brand.id;
      }

      const modelIds: number[] = [];
      if (brandId !== null && metadata.models.length > 0) {
        for (const modelName of metadata.models) {
          const carModel = await this.prisma.carModel.upsert({
            where: { brandId_name: { brandId, name: modelName } },
            update: {},
            create: { brandId, name: modelName },
          });
          modelIds.push(carModel.id);
        }
      }

      const primaryUrl = processedUrls[0];
      const gmKey = metadata.gm_number ?? `tg_${tgUserId}_${Date.now()}`;
      const product = await this.prisma.product.upsert({
        where: { gmNumber: gmKey },
        update: { title: metadata.title, description: metadata.description, imageUrl: primaryUrl },
        create: {
          gmNumber: metadata.gm_number,
          title: metadata.title,
          description: metadata.description,
          imageUrl: primaryUrl,
        },
      });

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

      for (const modelId of modelIds) {
        await this.prisma.partModel.upsert({
          where: { partId_modelId: { partId: product.id, modelId } },
          update: {},
          create: { partId: product.id, modelId },
        });
      }

      const price =
        metadata.price !== null ? new Decimal(metadata.price) : extractPriceFallback(caption);

      const stock = await this.prisma.stock.upsert({
        where: { sellerId_productId: { sellerId: seller.id, productId: product.id } },
        update: { priceUzs: price },
        create: { sellerId: seller.id, productId: product.id, priceUzs: price },
      });

      const report =
        `✅ *Товар добавлен в каталог MATOR.uz*\n\n` +
        `🔩 *Название:* ${metadata.title}\n` +
        `📝 *Описание:* ${metadata.description ?? '—'}\n` +
        `🏭 *Марка:* ${metadata.brand ?? '—'}\n` +
        `🚗 *Модель:* ${metadata.models.length > 0 ? metadata.models.join(', ') : '—'}\n` +
        `🔢 *OEM/GM №:* ${metadata.gm_number ?? '—'}\n` +
        `💰 *Цена:* ${price.toFixed(0)} UZS\n` +
        `🖼 *Фото:* ${processedUrls.length}\n` +
        `📦 *Stock ID:* #${stock.id}\n` +
        `🆔 *Product ID:* #${product.id}`;

      // Send the processed image(s) back to the seller (by Cloudinary URL —
      // Telegram fetches them; the processed buffers are not retained).
      await this.replyWithResult(ctx, processedUrls, report);
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

  /**
   * Send the processed result back to the seller:
   *   • single image  → photo + caption (report) in one message;
   *   • multiple       → media group (≤10) with the report on the first item.
   * Telegram media-group captions are plain text, so we strip Markdown markers
   * for the album case. Falls back to a text-only reply if media sending fails.
   */
  private async replyWithResult(ctx: Context, urls: string[], report: string): Promise<void> {
    const images = urls.slice(0, MAX_IMAGES_PER_LISTING);
    try {
      if (images.length === 1) {
        await ctx.replyWithPhoto(images[0], { caption: report, parse_mode: 'Markdown' });
        return;
      }
      // Media group: caption only on the first photo, plain text (no Markdown).
      const media = images.map((url, i) => ({
        type: 'photo' as const,
        media: url,
        ...(i === 0 ? { caption: report.replace(/[*_`]/g, '') } : {}),
      }));
      await ctx.replyWithMediaGroup(media);
    } catch (err) {
      this.logger.warn(
        `Failed to send result media, falling back to text: ${err instanceof Error ? err.message : String(err)}`,
      );
      await ctx.reply(report, { parse_mode: 'Markdown' });
    }
  }

  /**
   * Download → Photoroom pipeline → Cloudinary for each image, preserving order.
   * A single image failing is logged and skipped so the rest of the album still
   * publishes; the caller handles the all-failed case.
   */
  private async processImages(fileIds: string[]): Promise<string[]> {
    const urls: string[] = [];
    for (const fileId of fileIds) {
      try {
        const fileLink = await this.bot.telegram.getFileLink(fileId);
        const response = await axios.get<ArrayBuffer>(fileLink.href, {
          responseType: 'arraybuffer',
          timeout: 20_000,
        });
        const cleaned = await this.photoroom.removeBackground(Buffer.from(response.data));
        urls.push(await this.cloudinary.uploadBuffer(cleaned));
      } catch (err) {
        this.logger.warn(
          `Skipping one image (${fileId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return urls;
  }
}
