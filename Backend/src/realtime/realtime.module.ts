import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { WsAuthService } from './ws-auth.service';

/**
 * Realtime transport. AuthModule is imported for JWT verification material
 * (JwtKeyService + JwtModule). RealtimeGateway is exported so feature modules
 * (e.g. garage) can push events to connected clients.
 */
@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, WsAuthService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
