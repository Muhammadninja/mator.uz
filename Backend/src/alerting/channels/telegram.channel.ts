import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { renderAlertMessage } from '../alert-message';
import { resolveAlertingConfig, type AlertingConfig } from '../alerting.config';
import type {
  AlertChannel,
  AlertNotification,
  AlertSeverity,
} from '../alerting.types';

/**
 * Delivers alerts to Telegram.
 *
 * ── Why a send-only Telegraf client rather than injecting TelegramService ──
 * TelegramService is the SELLER bot: it owns the listing wizard, holds per-chat
 * session state, registers ~20 handlers and, critically, calls `bot.launch()`
 * to long-poll. Injecting it here would pull the entire wizard dependency graph
 * (Prisma, Cloudinary, catalog projection, the draft coordinator) into the
 * alerting path, and would make an alert send depend on a service whose failure
 * modes are the very thing we alert about.
 *
 * This client uses the SAME bot token by default (ALERT_TELEGRAM_BOT_TOKEN
 * falls back to TELEGRAM_BOT_TOKEN), so alerts arrive from the bot the team
 * already knows, but it never calls `launch()`. It only ever issues
 * `sendMessage`, a plain HTTPS call to the Bot API holding no polling
 * connection. Two Telegraf objects around one token is fine precisely because
 * only one of them polls.
 *
 * Delivery failures THROW: this runs inside a BullMQ worker, and throwing is
 * what triggers the retry/backoff. Swallowing would silently drop the alert.
 */
@Injectable()
export class TelegramAlertChannel implements AlertChannel {
  readonly name = 'telegram';

  private readonly logger = new Logger(TelegramAlertChannel.name);
  private readonly config: AlertingConfig;
  private readonly minSeverity: AlertSeverity;
  /** Built lazily on first send — an unconfigured deployment builds nothing. */
  private client?: Telegraf;

  constructor(config: ConfigService) {
    this.config = resolveAlertingConfig(config);
    this.minSeverity = this.config.telegramMinSeverity;
  }

  get configured(): boolean {
    return (
      this.config.telegramBotToken !== '' && this.config.telegramChatId !== ''
    );
  }

  accepts(notification: AlertNotification): boolean {
    return notification.severity >= this.minSeverity;
  }

  async deliver(notification: AlertNotification): Promise<void> {
    const text = renderAlertMessage(notification, this.config.environmentLabel);

    await this.bot().telegram.sendMessage(this.config.telegramChatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });

    this.logger.debug(`Telegram delivered ${notification.dedupeKey}`);
  }

  /** The send-only client, constructed once on first use. */
  private bot(): Telegraf {
    this.client ??= new Telegraf(this.config.telegramBotToken);
    return this.client;
  }
}
