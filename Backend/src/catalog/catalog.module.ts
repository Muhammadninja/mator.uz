import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PartsService } from './parts/parts.service';
import { PartsController } from './parts/parts.controller';
import { SearchService } from './search/search.service';
import { SearchController } from './search/search.controller';
import { TopFeaturedService } from './top-featured/top-featured.service';
import { TopFeaturedController } from './top-featured/top-featured.controller';
import { CatalogProjectionService } from './projection/catalog-projection.service';

@Module({
  imports: [PrismaModule],
  providers: [PartsService, SearchService, TopFeaturedService, CatalogProjectionService],
  controllers: [PartsController, SearchController, TopFeaturedController],
  // Exported so the Telegram pipeline (and future admin/seller tools) can
  // project supply-side writes into the buyer catalog through the single
  // authoritative mapping.
  exports: [CatalogProjectionService],
})
export class CatalogModule {}
