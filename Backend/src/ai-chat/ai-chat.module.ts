import { Module } from '@nestjs/common';
import { AiChatService } from './ai-chat.service';
import { AiChatController } from './ai-chat.controller';
import { RagSearchService } from './rag-search.service';
import { SourcingModule } from '../sourcing/sourcing.module';
import { EventsModule } from '../events/events.module';
import { SalesModule } from '../sales/sales.module';
import { TelegramNotifierModule } from '../telegram/telegram-notifier.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Anthropic-backed support/sourcing chat. Runs RAG over the catalog projection
 * (RagSearchService, PrismaModule is global), opens tickets via SourcingModule,
 * pushes NEW_SOURCING_TICKET events via EventsModule's admin gateway, prices
 * in-stock matches through SalesModule's DiscountService so the chat quotes the
 * same sale-adjusted price as the catalog, and fans new sourcing tickets out to
 * the dealers' Telegram group via TelegramNotifierModule. AuthModule provides
 * the passport JWT strategy the route's OptionalJwtAuthGuard relies on to bind a
 * ticket to the authenticated customer (anonymous still allowed).
 */
@Module({
  imports: [SourcingModule, EventsModule, SalesModule, TelegramNotifierModule, AuthModule],
  providers: [AiChatService, RagSearchService],
  controllers: [AiChatController],
  exports: [AiChatService],
})
export class AiChatModule {}
