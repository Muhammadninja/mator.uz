import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AddressesService } from './addresses.service';
import { AddressesController } from './addresses.controller';

/**
 * User address CRUD (Phase 4A). PrismaService comes from the global
 * PrismaModule; AuthModule provides the JWT guard the controller uses.
 */
@Module({
  imports: [AuthModule],
  providers: [AddressesService],
  controllers: [AddressesController],
  // Exported so the profile module (PATCH /v1/me) can reuse the same
  // address persistence/validation logic instead of duplicating it.
  exports: [AddressesService],
})
export class AddressesModule {}
