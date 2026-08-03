import { Module } from '@nestjs/common';
import { SourcingService } from './sourcing.service';
import { AdminSourcingController } from './admin-sourcing.controller';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';

/**
 * Sourcing-ticket persistence + the mator-admin operator console. PrismaModule
 * is global; AdminAuthModule is imported so AdminSourcingController can resolve
 * AdminJwtGuard/AdminRoleGuard (same wiring admin.module.ts uses). Exports
 * SourcingService for AiChatModule to open tickets.
 */
@Module({
  imports: [AdminAuthModule],
  providers: [SourcingService],
  controllers: [AdminSourcingController],
  exports: [SourcingService],
})
export class SourcingModule {}
