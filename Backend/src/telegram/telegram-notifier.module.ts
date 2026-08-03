import { Module } from '@nestjs/common';
import { TelegramNotifierService } from './telegram-notifier.service';

/**
 * Push-only Telegram notifications for backend events (currently AI sourcing
 * tickets). Kept separate from the heavy seller-bot `TelegramModule` so that
 * importing "send a Telegram message" doesn't drag in the listing wizard, its
 * session state, or the `bot.launch()` long-poll. Depends only on the global
 * ConfigModule, so it's cheap for any feature module to import.
 */
@Module({
  providers: [TelegramNotifierService],
  exports: [TelegramNotifierService],
})
export class TelegramNotifierModule {}
