import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminManagementController } from './admin-management.controller';
import { AdminManagementService } from './admin-management.service';

/**
 * Administrator management console (/v1/admins).
 *
 * Imports AdminAuthModule for the guards and the already-audited service layer
 * — no security logic is re-implemented here.
 */
@Module({
  imports: [PrismaModule, AdminAuthModule],
  providers: [AdminManagementService],
  controllers: [AdminManagementController],
  exports: [AdminManagementService],
})
export class AdminManagementModule {}
