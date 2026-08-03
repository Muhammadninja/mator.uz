import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { AdminWsAuthService } from './admin-ws-auth.service';
import { AdminEventsGateway } from './admin-events.gateway';

/**
 * Admin realtime transport. Provides its own JwtService for HS256 verification
 * and pulls AdminAuthConfig (the shared admin signing secret) from
 * AdminAuthModule. PrismaModule is global. Exports the gateway so AiChatModule
 * can push NEW_SOURCING_TICKET events.
 */
@Module({
  imports: [JwtModule.register({}), AdminAuthModule],
  providers: [AdminWsAuthService, AdminEventsGateway],
  exports: [AdminEventsGateway],
})
export class EventsModule {}
