import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesModule } from '../sales/sales.module';
import { PartsService } from './parts/parts.service';
import { PartsController } from './parts/parts.controller';
import { SearchService } from './search/search.service';
import { SearchController } from './search/search.controller';
import { CategoriesService } from './categories/categories.service';
import { CategoriesController } from './categories/categories.controller';
import { CatalogProjectionService } from './projection/catalog-projection.service';

@Module({
  // SalesModule exports DiscountService so buyer part prices reflect active sales.
  imports: [PrismaModule, SalesModule],
  providers: [PartsService, SearchService, CategoriesService, CatalogProjectionService],
  controllers: [PartsController, SearchController, CategoriesController],
  // Exported so the Telegram pipeline (and future admin/seller tools) can
  // project supply-side writes into the buyer catalog through the single
  // authoritative mapping.
  exports: [CatalogProjectionService],
})
export class CatalogModule {}
