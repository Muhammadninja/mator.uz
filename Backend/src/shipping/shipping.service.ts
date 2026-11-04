import { Injectable } from '@nestjs/common';
import { ShippingQuoteDto } from './dto/shipping-quote.dto';

/**
 * The delivery options an order can have, and what each costs. Only pickup for now:
 * courier delivery has no real price until the delivery provider gives a tariff for the
 * specific order, and a flat figure must not be quoted as if it were one. The inputs
 * are accepted for that later pricing.
 */
@Injectable()
export class ShippingService {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  quote(_dto: ShippingQuoteDto) {
    return {
      options: [
        {
          type: 'pickup',
          label: 'Olib ketish',
          price_uzs: 0,
          eta_days_min: 0,
          eta_days_max: 0,
        },
      ],
      currency: 'UZS',
    };
  }
}
