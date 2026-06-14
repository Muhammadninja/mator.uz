import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PartsService } from './parts/parts.service';
import { PartsController } from './parts/parts.controller';
import { SearchService } from './search/search.service';
import { SearchController } from './search/search.controller';
import { TopFeaturedService } from './top-featured/top-featured.service';
import { TopFeaturedController } from './top-featured/top-featured.controller';

@Module({
  imports: [PrismaModule],
  providers: [PartsService, SearchService, TopFeaturedService],
  controllers: [PartsController, SearchController, TopFeaturedController],
})
export class CatalogModule {}
