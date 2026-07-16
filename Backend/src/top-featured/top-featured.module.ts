import { Module } from '@nestjs/common';
import { TopFeaturedService } from './top-featured.service';
import { TopFeaturedController } from './top-featured.controller';

/**
 * Top Featured API (Phase 4B). Read-only over the seeded FeaturedItem table.
 * PrismaService comes from the global PrismaModule; public (no auth).
 */
@Module({
  providers: [TopFeaturedService],
  controllers: [TopFeaturedController],
})
export class TopFeaturedModule {}
