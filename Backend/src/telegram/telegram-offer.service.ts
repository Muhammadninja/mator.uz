import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import {
  Prisma,
  SourcingOfferCondition,
  SourcingTicketStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { CloudinaryFolder } from '../common/image.constants';
import { TelegramFileService } from './telegram-file.service';
import { SourcingOfferService } from '../sourcing/sourcing-offer.service';
import { parseOfferPrice } from './sourcing-offer-parse.util';

/** Deep-link start payload prefix: `/start offer_<ticketId>`. */
export const OFFER_DEEPLINK_PREFIX = 'offer_';

const SESSION_TTL_MS = 15 * 60_000; // a dealer has 15 min to complete a quote
const MAX_IMAGES = 6;

type OfferStep = 'PRICE' | 'CONDITION' | 'PHOTO';

interface OfferSession {
  ticketId: string;
  partName: string | null;
  step: OfferStep;
  price?: number;
  condition?: SourcingOfferCondition;
  note?: string;
  images: string[]; // durable Cloudinary URLs
  expiry: NodeJS.Timeout;
}

/**
 * The seller's "У меня есть" → DM offer-capture flow, isolated from the product
 * wizard.
 *
 * A dealer taps the inline button on a ticket card, which deep-links them into a
 * private chat with the bot (`/start offer_<ticketId>`). This service owns a
 * SEPARATE per-user session map and consume-or-passthrough hooks that
 * TelegramService calls at the top of its /start, text and photo handlers — so
 * an active offer session never collides with a product-draft wizard session.
 *
 * Price is the only required input; a photo is optional (uploaded inline to
 * Cloudinary for a durable URL). Completing the flow records a SourcingOffer,
 * which notifies the requesting customer.
 */
@Injectable()
export class TelegramOfferService {
  private readonly logger = new Logger(TelegramOfferService.name);
  private readonly sessions = new Map<number, OfferSession>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly offers: SourcingOfferService,
    private readonly cloudinary: CloudinaryService,
    private readonly telegramFile: TelegramFileService,
  ) {}

  /** Attach the offer flow's inline-button handlers (namespaced `sof:*`). */
  registerActions(bot: Telegraf): void {
    bot.action(/^sof:cond:(NEW|USED|SKIP)$/, async (ctx) => {
      await ctx.answerCbQuery().catch(() => undefined);
      const from = ctx.from;
      const s = from ? this.sessions.get(from.id) : undefined;
      if (!s) return;
      const choice = ctx.match[1];
      s.condition = choice === 'SKIP' ? undefined : (choice as SourcingOfferCondition);
      s.step = 'PHOTO';
      await ctx.reply(
        'Добавьте фото детали (по желанию) — можно несколько. ' +
          'Когда будете готовы, нажмите «Отправить предложение». Фото не обязательно.',
        this.submitKeyboard(),
      );
    });

    bot.action('sof:submit', async (ctx) => {
      await ctx.answerCbQuery().catch(() => undefined);
      await this.finalize(ctx);
    });

    bot.action('sof:cancel', async (ctx) => {
      await ctx.answerCbQuery('Отменено').catch(() => undefined);
      const from = ctx.from;
      if (from) this.clearSession(from.id);
      await ctx.reply('Предложение отменено.');
    });
  }

  /** True when the /start payload was an offer deep-link (consumed here). */
  async startFromDeepLink(ctx: Context, payload: string): Promise<boolean> {
    if (!payload || !payload.startsWith(OFFER_DEEPLINK_PREFIX)) return false;
    const from = ctx.from;
    if (!from) return true;

    const ticketId = payload.slice(OFFER_DEEPLINK_PREFIX.length).trim();
    const ticket = ticketId
      ? await this.prisma.sourcingTicket.findUnique({ where: { id: ticketId } })
      : null;
    if (!ticket) {
      await ctx.reply('Заявка не найдена — возможно, она уже закрыта.');
      return true;
    }
    if (
      ticket.status === SourcingTicketStatus.CLOSED ||
      ticket.status === SourcingTicketStatus.CANCELLED
    ) {
      await ctx.reply('Эта заявка уже закрыта.');
      return true;
    }

    const partName = this.partName(ticket.extractedData);
    this.setSession(from.id, { ticketId, partName, step: 'PRICE', images: [] });
    await ctx.reply(
      `Заявка на запчасть: ${partName ?? 'запчасть'}\n\n` +
        'Укажите вашу цену в сумах (например 250000):',
    );
    return true;
  }

  /** True when the text belonged to an active offer session (consumed here). */
  async handleText(ctx: Context): Promise<boolean> {
    const from = ctx.from;
    if (!from) return false;
    const s = this.sessions.get(from.id);
    if (!s) return false;

    const msg = ctx.message;
    const text = msg && 'text' in msg ? msg.text : '';

    if (s.step === 'PRICE') {
      const price = parseOfferPrice(text);
      if (price == null) {
        await ctx.reply('Введите цену числом, например 250000.');
        return true;
      }
      s.price = price;
      s.step = 'CONDITION';
      await ctx.reply(
        `Цена: ${this.formatPrice(price)} сум.\nСостояние детали?`,
        this.conditionKeyboard(),
      );
      return true;
    }

    // CONDITION / PHOTO: free text is treated as an optional note.
    s.note = text.slice(0, 500);
    if (s.step === 'CONDITION') s.step = 'PHOTO';
    await ctx.reply(
      'Комментарий сохранён. Добавьте фото (по желанию) или нажмите «Отправить предложение».',
      this.submitKeyboard(),
    );
    return true;
  }

  /** True when the photo belonged to an active offer session (consumed here). */
  async handlePhoto(ctx: Context, fileId: string): Promise<boolean> {
    const from = ctx.from;
    if (!from) return false;
    const s = this.sessions.get(from.id);
    if (!s) return false;

    if (s.step === 'PRICE') {
      await ctx.reply('Сначала укажите цену числом, например 250000.');
      return true;
    }
    if (s.images.length >= MAX_IMAGES) {
      await ctx.reply('Достаточно фото. Нажмите «Отправить предложение».', this.submitKeyboard());
      return true;
    }

    const url = await this.uploadPhoto(fileId);
    if (!url) {
      await ctx.reply('Не удалось загрузить фото, попробуйте ещё раз.');
      return true;
    }
    s.images.push(url);
    s.step = 'PHOTO';
    await ctx.reply(
      `Фото добавлено (${s.images.length}). Ещё фото или нажмите «Отправить предложение».`,
      this.submitKeyboard(),
    );
    return true;
  }

  /** Drop all in-memory sessions (called on module shutdown). */
  clear(): void {
    for (const s of this.sessions.values()) clearTimeout(s.expiry);
    this.sessions.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async finalize(ctx: Context): Promise<void> {
    const from = ctx.from;
    const s = from ? this.sessions.get(from.id) : undefined;
    if (!from || !s) return;
    if (s.price == null) {
      await ctx.reply('Сначала укажите цену числом, например 250000.');
      return;
    }

    try {
      await this.offers.createOffer({
        ticketId: s.ticketId,
        price: s.price,
        condition: s.condition ?? 'UNKNOWN',
        note: s.note ?? null,
        images: s.images,
        sellerTgId: String(from.id),
        sellerName: from.first_name ?? null,
        sellerUsername: from.username ?? null,
      });
      this.clearSession(from.id);
      await ctx.reply(
        '✅ Предложение отправлено покупателю. Спасибо! Мы уведомим вас, если он согласится.',
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        this.clearSession(from.id);
        await ctx.reply('Заявка уже закрыта — предложение не отправлено.');
        return;
      }
      this.logger.error(
        `Failed to record offer for ticket ${s.ticketId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await ctx.reply('Не удалось отправить предложение. Попробуйте ещё раз позже.');
    }
  }

  private async uploadPhoto(fileId: string): Promise<string | null> {
    try {
      const src = await this.telegramFile.getFileUrl(fileId);
      const res = await fetch(src);
      if (!res.ok) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      const uploaded = await this.cloudinary.uploadBuffer(
        buffer,
        CloudinaryFolder.SOURCING_OFFERS,
      );
      return uploaded.url;
    } catch (err) {
      this.logger.warn(
        `Offer photo upload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private setSession(
    userId: number,
    partial: Omit<OfferSession, 'expiry'>,
  ): void {
    this.clearSession(userId);
    const expiry = setTimeout(() => this.sessions.delete(userId), SESSION_TTL_MS);
    expiry.unref?.();
    this.sessions.set(userId, { ...partial, expiry });
  }

  private clearSession(userId: number): void {
    const s = this.sessions.get(userId);
    if (s) {
      clearTimeout(s.expiry);
      this.sessions.delete(userId);
    }
  }

  private conditionKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('🆕 Новый', 'sof:cond:NEW'),
        Markup.button.callback('♻️ Б/у', 'sof:cond:USED'),
      ],
      [Markup.button.callback('Пропустить', 'sof:cond:SKIP')],
    ]);
  }

  private submitKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📤 Отправить предложение', 'sof:submit')],
      [Markup.button.callback('❌ Отмена', 'sof:cancel')],
    ]);
  }

  private partName(extractedData: Prisma.JsonValue): string | null {
    if (
      extractedData &&
      typeof extractedData === 'object' &&
      !Array.isArray(extractedData)
    ) {
      const v = (extractedData as Record<string, unknown>).part_name;
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  private formatPrice(price: number): string {
    return price.toLocaleString('ru-RU').replace(/ /g, ' ');
  }
}
