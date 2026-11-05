import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeliveryQuoteService } from './delivery-quote.service';
import { ROUTING_PROVIDER } from './routing/routing-provider';
import { UzmapsRoutingProvider } from './routing/uzmaps-routing.provider';
import { UzmapsUsageMonitor } from './routing/uzmaps-usage.monitor';
import { ShippingService } from './shipping.service';
import { ShippingController } from './shipping.controller';

@Module({
  imports: [AuthModule],
  providers: [
    ShippingService,
    DeliveryQuoteService,
    // The one line that names the routing provider: see routing-provider.ts.
    { provide: ROUTING_PROVIDER, useClass: UzmapsRoutingProvider },
    UzmapsUsageMonitor,
  ],
  controllers: [ShippingController],
  // OrdersModule charges what a quote computes, through the same service.
  exports: [DeliveryQuoteService],
})
export class ShippingModule {}
