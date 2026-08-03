import { Module } from '@nestjs/common';
import { AiChatService } from './ai-chat.service';
import { AiChatController } from './ai-chat.controller';
import { RagSearchService } from './rag-search.service';
import { SourcingModule } from '../sourcing/sourcing.module';
import { EventsModule } from '../events/events.module';

/**
 * Anthropic-backed support/sourcing chat. Runs RAG over the catalog projection
 * (RagSearchService, PrismaModule is global), opens tickets via SourcingModule,
 * and pushes NEW_SOURCING_TICKET events via EventsModule's admin gateway.
 */
@Module({
  imports: [SourcingModule, EventsModule],
  providers: [AiChatService, RagSearchService],
  controllers: [AiChatController],
  exports: [AiChatService],
})
export class AiChatModule {}
