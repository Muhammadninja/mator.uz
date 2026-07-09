import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { SellersModule } from '../sellers/sellers.module';
import { CatalogModule } from '../catalog/catalog.module';

@Module({
  // CatalogModule provides CatalogProjectionService so a confirmed listing is
  // immediately projected into the buyer catalog (live read model).
  imports: [SellersModule, CatalogModule],
  providers: [TelegramService],
})
export class TelegramModule {}
