import { Module } from '@nestjs/common';
import { SourcingService } from './sourcing.service';

/**
 * Sourcing-ticket persistence. PrismaModule is global, so no imports are
 * needed. Exports SourcingService for AiChatModule (and a future admin
 * tickets controller) to consume.
 */
@Module({
  providers: [SourcingService],
  exports: [SourcingService],
})
export class SourcingModule {}
