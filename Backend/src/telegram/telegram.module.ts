import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { SellersModule } from '../sellers/sellers.module';
import { CatalogModule } from '../catalog/catalog.module';
import { PartCategoryModule } from '../catalog/categories/part-category.module';
import { ProductDraftModule } from './product-draft.module';

@Module({
  // CatalogModule provides CatalogProjectionService so a confirmed listing is
  // immediately projected into the buyer catalog (live read model).
  // ProductDraftModule provides ProductDraftService + DraftCoordinator for the
  // photos-first draft flow (also imported by QueueModule for the worker).
  imports: [
    SellersModule,
    CatalogModule,
    ProductDraftModule,
    // The dynamic category tree the wizard's category steps read.
    PartCategoryModule,
  ],
  providers: [TelegramService],
})
export class TelegramModule {}
