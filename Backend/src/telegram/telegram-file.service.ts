import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegram } from 'telegraf';

/**
 * TelegramFileService — resolves a downloadable URL for a Telegram file_id.
 *
 * This is the ONLY Telegram capability the image worker needs, and it is a
 * DOWNLOAD, never a sendMessage. It wraps a standalone `Telegram` API client
 * (telegraf) built straight from TELEGRAM_BOT_TOKEN — deliberately NOT the polling
 * bot in TelegramService. Keeping it separate means:
 *   • the worker has no dependency on TelegramService (no Queue↔Telegram cycle),
 *   • the worker never gains the ability to message sellers (that stays event-
 *     driven, in TelegramService's @OnEvent handlers).
 * A standalone Telegram client does no long-polling; it is just an API wrapper, so
 * constructing a second one is cheap.
 */
@Injectable()
export class TelegramFileService {
  private readonly logger = new Logger(TelegramFileService.name);
  private readonly telegram: Telegram;

  constructor(config: ConfigService) {
    const token = config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    this.telegram = new Telegram(token);
  }

  /** Resolve a fresh, downloadable HTTPS URL for a Telegram file_id. Telegram file
   *  links are short-lived, so this is called at processing time (in the worker),
   *  not at upload time. */
  async getFileUrl(fileId: string): Promise<string> {
    const link = await this.telegram.getFileLink(fileId);
    return link.href;
  }
}
