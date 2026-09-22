import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramOfferService } from './telegram-offer.service';
import { DriversVillagePhotoService } from './drivers-village-photo.service';
import { SellersModule } from '../sellers/sellers.module';
import { CatalogModule } from '../catalog/catalog.module';
import { PartCategoryModule } from '../catalog/categories/part-category.module';
import { ProductDraftModule } from './product-draft.module';
import { SourcingModule } from '../sourcing/sourcing.module';

@Module({
  // CatalogModule provides CatalogProjectionService so a confirmed listing is
  // immediately projected into the buyer catalog (live read model).
  // ProductDraftModule provides ProductDraftService + DraftCoordinator for the
  // photos-first draft flow (also imported by QueueModule for the worker), and
  // exports TelegramFileService (file_id → download URL) used by the offer flow.
  // SourcingModule provides SourcingOfferService so the "У меня есть" DM flow can
  // record a seller's quote against a ticket.
  imports: [
    SellersModule,
    CatalogModule,
    ProductDraftModule,
    // The dynamic category tree the wizard's category steps read.
    PartCategoryModule,
    SourcingModule,
  ],
  // DriversVillagePhotoService: Driver's Village photo updates (album + caption
  // = code_1c) — position lookup and gallery replacement for TelegramService.
  providers: [
    TelegramService,
    TelegramOfferService,
    DriversVillagePhotoService,
  ],
})
export class TelegramModule {}
