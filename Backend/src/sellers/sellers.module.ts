import { Module } from '@nestjs/common';
import { SellersService } from './sellers.service';

@Module({
  providers: [SellersService],
  exports: [SellersService],
})
export class SellersModule {}
