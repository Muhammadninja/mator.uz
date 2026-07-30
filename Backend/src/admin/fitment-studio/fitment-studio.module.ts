import { Module } from '@nestjs/common';

import { AdminAuthModule } from '../auth/admin-auth.module';
import { FitmentStudioController } from './fitment-studio.controller';
import { FitmentStudioService } from './fitment-studio.service';

/**
 * FitmentStudioModule — registered in AppModule via AdminModule's imports.
 * PrismaService comes from the @Global PrismaModule (no import needed here).
 * AdminAuthModule provides the AdminJwtGuard/AdminRoleGuard stack the controller
 * uses (mirrors how the other admin consoles are guarded).
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [FitmentStudioController],
  providers: [FitmentStudioService],
  exports: [FitmentStudioService],
})
export class FitmentStudioModule {}
