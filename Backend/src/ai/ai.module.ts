import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AIService } from './ai.service';
import { AIController } from './ai.controller';

/**
 * INTENTIONALLY INACTIVE — this module is not imported by AppModule, so the
 * `/api/ai/diagnose` route is not registered at runtime. The live AI surface is
 * AiAdvisorModule (`/v1/ai/...`), which is JWT-guarded. The other AI helpers
 * under `src/ai/` are consumed directly by the Telegram listing pipeline.
 *
 * Before ever registering it: the diagnose route is currently unauthenticated,
 * has no input validation (uncapped LLM cost), and exposes seller phone in its
 * results. Add auth, DTO validation, and rate limiting first (see the audit).
 */
@Module({
  imports: [PrismaModule],
  providers: [AIService],
  controllers: [AIController],
})
export class AIModule {}
