import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesModule } from '../sales/sales.module';
import { AuthModule } from '../auth/auth.module';
import { PartsService } from './parts/parts.service';
import { PartsController } from './parts/parts.controller';
import { SearchService } from './search/search.service';
import { SearchController } from './search/search.controller';
import { CategoriesService } from './categories/categories.service';
import { CategoriesController } from './categories/categories.controller';
import { CatalogProjectionService } from './projection/catalog-projection.service';

@Module({
  // SalesModule exports DiscountService so buyer part prices reflect active sales.
  // AuthModule provides the passport JWT strategy behind the OptionalJwtAuthGuard
  // on check-compatibility (scopes the vehicle lookup to the caller's garage).
  imports: [PrismaModule, SalesModule, AuthModule],
  providers: [
    PartsService,
    SearchService,
    CategoriesService,
    CatalogProjectionService,
  ],
  controllers: [PartsController, SearchController, CategoriesController],
  // CatalogProjectionService is exported so the Telegram pipeline (and future
  // admin/seller tools) can project supply-side writes into the buyer catalog
  // through the single authoritative mapping.
  //
  // PartsService/CategoriesService are exported for the AI advisor's catalogue
  // tools: the assistant must answer from the SAME code path that serves
  // GET /v1/catalog/parts (sale pricing, fitment, motor-oil rules included),
  // rather than querying Prisma itself and drifting from the buyer catalogue.
  exports: [CatalogProjectionService, PartsService, CategoriesService],
})
export class CatalogModule {}
