import { Module } from '@nestjs/common';
import { DealersService } from './dealers.service';
import { DealersController } from './dealers.controller';

/**
 * MATOR Certified dealers API (Phase 4C). Read-only over the seeded
 * CatalogSeller table. PrismaService comes from the global PrismaModule; public.
 */
@Module({
  providers: [DealersService],
  controllers: [DealersController],
})
export class DealersModule {}
