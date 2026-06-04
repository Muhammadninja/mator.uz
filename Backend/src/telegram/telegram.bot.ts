// src/telegram/telegram.bot.ts
import { Decimal } from '@prisma/client/runtime/library';
import axios from 'axios';
import { Context, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { ClaudeMcpService } from '../ai/claude-mcp.service';
import { PhotoroomService } from '../ai/photoroom.service';
import { prisma } from '../database/prisma.service';

const photoroomService = new PhotoroomService();
const claudeService = new ClaudeMcpService();

function extractPrice(text: string): Decimal {
  // Look for pattern like "30000 uzs", "30000 UZS", "30000 сўм", "30000сўм"
  const currencyMatch = text.match(/(\d+)\s*(uzs|UZS|сўм|сум)/i);
  if (currencyMatch) {
    return new Decimal(currencyMatch[1]);
  }

  // Fallback: extract numbers, exclude small ones (likely part numbers), take largest
  const matches = text.match(/\d+/g);
  if (!matches) return new Decimal(0);

  // Filter out numbers that look like part/OEM codes (typically 5-7 digits)
  // and could be confused with price. Keep numbers that are clearly prices (4+ digits usually ≥1000)
  const candidates = matches.map(Number).filter((n) => n > 1000);
  if (candidates.length > 0) {
    return new Decimal(Math.max(...candidates));
  }

  // If no clear price found, take the largest number as fallback
  const price = Math.max(...matches.map(Number));
  return new Decimal(price);
}

async function downloadTelegramFile(
  bot: Telegraf,
  fileId: string,
): Promise<Buffer> {
  const fileLink = await bot.telegram.getFileLink(fileId);
  const response = await axios.get<ArrayBuffer>(fileLink.href, {
    responseType: 'arraybuffer',
    timeout: 20_000,
  });
  return Buffer.from(response.data);
}

export function createTelegramBot(): Telegraf {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const bot = new Telegraf(token);

  bot.on(message('photo'), async (ctx: Context) => {
    // Narrow the context — message is guaranteed to exist here
    const msg = ctx.message;
    if (!msg || !('photo' in msg)) return;

    const caption = msg.caption;
    if (!caption || caption.trim() === '') {
      await ctx.reply(
        '❌ Пожалуйста, добавьте подпись к фото с названием детали, номером и ценой.',
      );
      return;
    }

    const from = msg.from;
    if (!from) return;

    try {
      // 1. Download highest-resolution photo
      const photos = msg.photo;
      const bestPhoto = photos[photos.length - 1];
      const originalBuffer = await downloadTelegramFile(bot, bestPhoto.file_id);

      // 2. Remove background via Photoroom
      const cleanedBuffer = await photoroomService.removeBackground(originalBuffer);

      // 3. Parse metadata via Claude
      const metadata = await claudeService.parsePartText(caption);

      // 4. Upsert pipeline: Seller → Product → Stock
      const seller = await prisma.seller.upsert({
        where: { tgId: BigInt(from.id) },
        update: {},
        create: {
          tgId: BigInt(from.id),
          phone: '',               // будет заполнено при полноценной регистрации
          storeName: from.username ?? from.first_name,
        },
      });

      const product = await prisma.product.upsert({
        where: {
          gmNumber: metadata.gm_number ?? `tg_${from.id}_${Date.now()}`,
        },
        update: {
          title: metadata.title,
          carModel: metadata.car_model,
        },
        create: {
          gmNumber: metadata.gm_number,
          title: metadata.title,
          carModel: metadata.car_model,
        },
      });

      const price = extractPrice(caption);

      const stock = await prisma.stock.upsert({
        where: {
          sellerId_productId: { sellerId: seller.id, productId: product.id },
        },
        update: { priceUzs: price },
        create: {
          sellerId: seller.id,
          productId: product.id,
          priceUzs: price,
        },
      });

      // 5. Reply with cleaned image + structured report
      const report =
        `✅ *Товар добавлен в каталог MATOR.uz*\n\n` +
        `🔩 *Деталь:* ${metadata.title}\n` +
        `🚗 *Модель:* ${metadata.car_model ?? '—'}\n` +
        `🔢 *OEM/GM №:* ${metadata.gm_number ?? '—'}\n` +
        `💰 *Цена:* ${price.toFixed(0)} UZS\n` +
        `📦 *Stock ID:* #${stock.id}\n` +
        `🆔 *Product ID:* #${product.id}`;

      await ctx.replyWithDocument(
        { source: cleanedBuffer, filename: `${product.id}_clean.png` },
        { caption: report, parse_mode: 'Markdown' },
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Неизвестная ошибка';
      console.error('[TelegramBot] Pipeline error:', msg);
      await ctx.reply(
        `⚠️ Произошла ошибка при обработке товара.\n\`${msg}\``,
        { parse_mode: 'Markdown' },
      );
    }
  });

  return bot;
}
