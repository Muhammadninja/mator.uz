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
})
export class AddressesModule {}
