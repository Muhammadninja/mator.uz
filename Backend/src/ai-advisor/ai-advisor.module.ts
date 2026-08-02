import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RedisModule } from '../redis/redis.module';
import { CatalogModule } from '../catalog/catalog.module';
import { AiAdvisorService } from './ai-advisor.service';
import { ClaudeService } from './claude.service';
import { CatalogToolsService } from './catalog-tools.service';
import { AiAdvisorController } from './ai-advisor.controller';

@Module({
  // RedisModule supplies the shared RATE_LIMITER (the same fixed-window limiter
  // OTP and login use — no second implementation). CatalogModule supplies the
  // authoritative catalogue services the AI tools read through, so a chat reply
  // and the catalogue screen cannot quote different prices.
  imports: [
    PrismaModule,
    AuthModule,
    NotificationsModule,
    RedisModule,
    CatalogModule,
  ],
  providers: [AiAdvisorService, ClaudeService, CatalogToolsService],
  controllers: [AiAdvisorController],
})
export class AiAdvisorModule {}
