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

function extractPriceFallback(text: string): Decimal {
  const currencyMatch = text.match(/(\d+)\s*(uzs|UZS|сўм|сум)/i);
  if (currencyMatch) return new Decimal(currencyMatch[1]);

  const matches = text.match(/\d+/g);
  if (!matches) return new Decimal(0);

  const candidates = matches.map(Number).filter((n) => n > 1000);
  if (candidates.length > 0) return new Decimal(Math.max(...candidates));

  return new Decimal(Math.max(...matches.map(Number)));
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

      if (!metadata.title || metadata.title.length < 3) {
        await ctx.reply(
          '❌ Не удалось распознать название детали. Опишите товар подробнее:\n' +
          '_Пример: Фильтр масляный Cobalt Gentra 96535062 25000 сум_',
          { parse_mode: 'Markdown' },
        );
        return;
      }

      // 4. Upsert pipeline: Seller → Brand → CarModels → Product → PartModels → Stock
      const seller = await prisma.seller.upsert({
        where: { tgId: BigInt(from.id) },
        update: {},
        create: {
          tgId: BigInt(from.id),
          phone: '',
          storeName: from.username ?? from.first_name,
        },
      });

      // Find or create brand
      let brandId: number | null = null;
      if (metadata.brand) {
        const brand = await prisma.brand.upsert({
          where: { name: metadata.brand },
          update: {},
          create: { name: metadata.brand },
        });
        brandId = brand.id;
      }

      // Find or create each car model
      const modelIds: number[] = [];
      if (brandId !== null && metadata.models.length > 0) {
        for (const modelName of metadata.models) {
          const carModel = await prisma.carModel.upsert({
            where: { brandId_name: { brandId, name: modelName } },
            update: {},
            create: { brandId, name: modelName },
          });
          modelIds.push(carModel.id);
        }
      }

      // Upsert product
      const gmKey = metadata.gm_number ?? `tg_${from.id}_${Date.now()}`;
      const product = await prisma.product.upsert({
        where: { gmNumber: gmKey },
        update: { title: metadata.title },
        create: {
          gmNumber: metadata.gm_number,
          title: metadata.title,
        },
      });

      // Link product to car models
      for (const modelId of modelIds) {
        await prisma.partModel.upsert({
          where: { partId_modelId: { partId: product.id, modelId } },
          update: {},
          create: { partId: product.id, modelId },
        });
      }

      // Upsert stock
      const price =
        metadata.price !== null
          ? new Decimal(metadata.price)
          : extractPriceFallback(caption);

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
      const modelsLine =
        metadata.models.length > 0
          ? metadata.models.join(', ')
          : '—';
      const brandLine = metadata.brand ?? '—';

      const report =
        `✅ *Товар добавлен в каталог MATOR.uz*\n\n` +
        `🔩 *Деталь:* ${metadata.title}\n` +
        `🏭 *Марка:* ${brandLine}\n` +
        `🚗 *Модели:* ${modelsLine}\n` +
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
