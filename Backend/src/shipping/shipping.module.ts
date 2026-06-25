import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ShippingService } from './shipping.service';
import { ShippingController } from './shipping.controller';

@Module({
  imports: [AuthModule],
  providers: [ShippingService],
  controllers: [ShippingController],
})
export class ShippingModule {}
