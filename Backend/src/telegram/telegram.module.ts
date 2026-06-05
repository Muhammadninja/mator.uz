import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { SellersModule } from '../sellers/sellers.module';

@Module({
  imports: [SellersModule],
  providers: [TelegramService],
})
export class TelegramModule {}
