import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { ApiKeyGuard } from './guards/api-key.guard';

/**
 * Dealer/supplier integration surface (1C stock upload).
 *
 * Self-contained and additive: it introduces no provider that any other module
 * consumes, and writes only the inventory columns of catalog rows that already
 * exist. PrismaService comes from the global PrismaModule.
 *
 * ApiKeyGuard is registered as a normal provider (NOT an APP_GUARD): it must
 * protect these routes only. Bound globally it would demand an X-API-KEY on
 * every endpoint in the app.
 */
@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, ApiKeyGuard],
})
export class IntegrationsModule {}
