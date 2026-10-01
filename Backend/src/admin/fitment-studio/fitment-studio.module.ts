import { Module } from '@nestjs/common';

import { AdminAuthModule } from '../auth/admin-auth.module';
import { FitmentQueueController } from './fitment-queue.controller';
import { FitmentQueueService } from './fitment-queue.service';
import { FitmentStudioController } from './fitment-studio.controller';
import { FitmentStudioService } from './fitment-studio.service';
import { FITMENT_TOP300_PART_IDS } from './top300/fitment-top300.list';
import { FITMENT_TOP300_LIST } from './top300/top300-list';

/**
 * FitmentStudioModule — registered in AppModule via AdminModule's imports.
 * PrismaService comes from the @Global PrismaModule (no import needed here).
 * AdminAuthModule provides the AdminJwtGuard/AdminRoleGuard stack the
 * controllers use (mirrors how the other admin consoles are guarded).
 *
 * Two surfaces over the same fitment_bindings table: the car-first studio at
 * /v1/admin/fitment-studio, and the part-first conveyor at /v1/admin/fitment
 * that the admin panel actually drives today.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [FitmentStudioController, FitmentQueueController],
  providers: [
    FitmentStudioService,
    FitmentQueueService,
    // The explicit business TOP-300 (top300/fitment-top300.list.ts).
    { provide: FITMENT_TOP300_LIST, useValue: FITMENT_TOP300_PART_IDS },
  ],
  exports: [FitmentStudioService, FitmentQueueService],
})
export class FitmentStudioModule {}
