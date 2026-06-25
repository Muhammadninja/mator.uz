import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShippingQuoteDto } from './dto/shipping-quote.dto';

const DEFAULT_COURIER_UZS = 25000;

/**
 * Temporary flat-rate shipping quote. Pricing mirrors the orders checkout
 * (DELIVERY_COURIER_UZS) so a quote matches what the order will charge. This is
 * a placeholder for a future distance/zone-based or Yandex-Delivery integration.
 */
@Injectable()
export class ShippingService {
  constructor(private readonly config: ConfigService) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  quote(_dto: ShippingQuoteDto) {
    const courierUzs = Number(this.config.get<string>('DELIVERY_COURIER_UZS') ?? DEFAULT_COURIER_UZS);
    return {
      options: [
        { type: 'pickup', label: 'Olib ketish', price_uzs: 0, eta_days_min: 0, eta_days_max: 0 },
        { type: 'courier', label: 'Kuryer', price_uzs: courierUzs, eta_days_min: 1, eta_days_max: 3 },
      ],
      currency: 'UZS',
    };
  }
}
