import { HttpException, Injectable } from '@nestjs/common';
import {
  COURIER_DELIVERY_UNAVAILABLE,
  DELIVERY_OUTSIDE_COVERAGE,
} from './delivery-coverage';
import {
  DELIVERY_ADDRESS_COORDINATES_MISSING,
  DELIVERY_ADDRESS_REQUIRED,
  DELIVERY_ROUTE_NOT_FOUND,
  DELIVERY_ROUTING_UNAVAILABLE,
  DeliveryQuoteService,
  PICKUP_LOCATION_MISSING,
} from './delivery-quote.service';
import { ShippingQuoteDto } from './dto/shipping-quote.dto';

/**
 * The refusals that mean "no courier for this cart and address right now": the area, the
 * address, a seller's pickup point or the routing provider stand in the way. Only these are
 * answered as a courier option that is not available, beside pickup. Anything else is not
 * about availability (someone else's address, an empty cart, a fault) and stays an error.
 */
export const COURIER_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  DELIVERY_ADDRESS_REQUIRED,
  COURIER_DELIVERY_UNAVAILABLE,
  DELIVERY_ADDRESS_COORDINATES_MISSING,
  DELIVERY_OUTSIDE_COVERAGE,
  PICKUP_LOCATION_MISSING,
  DELIVERY_ROUTE_NOT_FOUND,
  DELIVERY_ROUTING_UNAVAILABLE,
]);

const PICKUP_LABEL = 'Olib ketish';
const COURIER_LABEL = 'Kuryer';

/** Why the courier is not available, in the words of the refusal that said so. */
export interface UnavailableReason {
  code: string;
  message: string;
}

/** One way to get the order, as a client that asks for the courier price reads it. */
export interface ShippingOption {
  type: 'pickup' | 'courier';
  label: string;
  available: boolean;
  /** Whole UZS. Null exactly when the option is not available: never shown as free. */
  price_uzs: number | null;
  /** What a courier price was for. Placing the order hands it back: see deliveryQuoteId. */
  quote_id: string | null;
  unavailable_reason: UnavailableReason | null;
}

/** The refusal's code and words, when it is one of {@link COURIER_UNAVAILABLE_CODES}. */
function courierRefusal(err: unknown): UnavailableReason | null {
  if (!(err instanceof HttpException)) return null;
  const body = err.getResponse();
  if (typeof body !== 'object' || body === null) return null;
  const { code, message } = body as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !COURIER_UNAVAILABLE_CODES.has(code)) {
    return null;
  }
  return { code, message: typeof message === 'string' ? message : code };
}

/**
 * The delivery options an order can have, and what each costs.
 *
 * A client that asks for the courier price (`delivery_method: 'courier'`) gets both options:
 * pickup, which is always available and free, and Mator's own courier, either with the price
 * the existing calculator computes or marked unavailable with the reason. A courier that
 * cannot be priced is never offered as available, and its refusal never takes pickup with it.
 *
 * App builds already installed ask without naming a method and read every option they get as
 * selectable, with a "Today" they make up when an option states no ETA. They cannot place a
 * priced courier order either: they send no confirmed price. So they keep the answer they have
 * always had, pickup alone.
 *
 * The courier option carries a price and nothing else about the trip: no distance, no
 * duration. The buyer sees only what they pay.
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
    if (dto.delivery_method !== 'courier') {
      return {
        options: [
          {
            type: 'pickup',
            label: PICKUP_LABEL,
            price_uzs: 0,
            eta_days_min: 0,
            eta_days_max: 0,
          },
        ],
        currency: 'UZS',
      };
    }

    const pickup: ShippingOption = {
      type: 'pickup',
      label: PICKUP_LABEL,
      available: true,
      price_uzs: 0,
      quote_id: null,
      unavailable_reason: null,
    };
    return {
      options: [pickup, await this.courier(userId, dto.delivery_address_id)],
      currency: 'UZS',
    };
  }

  /**
   * The courier option, from the calculator. A refusal about availability becomes the
   * option's reason. Any other error propagates: a request for someone else's address stays a
   * 404 and an empty cart a 400, and a fault is not dressed up as "unavailable".
   */
  private async courier(
    userId: string,
    addressId: string | undefined,
  ): Promise<ShippingOption> {
    try {
      const { priceUzs, quoteId } = await this.quotes.quoteCart(
        userId,
        addressId,
      );
      return {
        type: 'courier',
        label: COURIER_LABEL,
        available: true,
        price_uzs: priceUzs,
        quote_id: quoteId,
        unavailable_reason: null,
      };
    } catch (err) {
      const reason = courierRefusal(err);
      if (!reason) throw err;
      return {
        type: 'courier',
        label: COURIER_LABEL,
        available: false,
        price_uzs: null,
        quote_id: null,
        unavailable_reason: reason,
      };
    }
  }
}
