import { Injectable } from '@nestjs/common';
import { DeliveryQuoteService } from './delivery-quote.service';
import { ShippingQuoteDto } from './dto/shipping-quote.dto';

/**
 * The delivery options an order can have, and what each costs.
 *
 * Courier delivery is priced only when asked for by name. App builds already installed
 * ask without naming a method and read every option they get as selectable, with a "Today"
 * they make up when an option states no ETA. So they keep the answer they have always had,
 * pickup alone, and a refusal to price a courier cannot break them.
 *
 * The courier option carries a price and nothing else about the trip: no distance, no
 * duration. The buyer sees only what they pay. `quote_id` names what that price was for, and
 * placing the order hands it back: see deliveryQuoteId.
 */
@Injectable()
export class ShippingService {
  constructor(private readonly quotes: DeliveryQuoteService) {}

  /**
   * Whether couriers operate, and where: the very geometry enforced on saving an address and
   * on quoting, so the app can tell a buyer on the map before they get that far. The box
   * around it is for opening the map there. The checks here remain the ones that count.
   */
  coverage() {
    const coverage = this.quotes.coverage;
    if (!coverage) return { configured: false, bounds: null, geometry: null };
    const { minLng, minLat, maxLng, maxLat } = coverage.bounds;
    return {
      configured: true,
      bounds: {
        min_lat: minLat,
        min_lng: minLng,
        max_lat: maxLat,
        max_lng: maxLng,
      },
      geometry: { type: 'MultiPolygon', coordinates: coverage.polygons },
    };
  }

  async quote(userId: string, dto: ShippingQuoteDto) {
    if (dto.delivery_method === 'courier') {
      const { priceUzs, quoteId } = await this.quotes.quoteCart(
        userId,
        dto.delivery_address_id,
      );
      return {
        options: [
          {
            type: 'courier',
            label: 'Kuryer',
            price_uzs: priceUzs,
            quote_id: quoteId,
          },
        ],
        currency: 'UZS',
      };
    }
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
