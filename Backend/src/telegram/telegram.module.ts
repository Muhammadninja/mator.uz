import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { SellersModule } from '../sellers/sellers.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ProductDraftModule } from './product-draft.module';

@Module({
  // CatalogModule provides CatalogProjectionService so a confirmed listing is
  // immediately projected into the buyer catalog (live read model).
  // ProductDraftModule provides ProductDraftService + DraftCoordinator for the
  // photos-first parallel flow (also imported by QueueModule for the worker).
  imports: [SellersModule, CatalogModule, ProductDraftModule],
  providers: [TelegramService],
})
export class TelegramModule {}
