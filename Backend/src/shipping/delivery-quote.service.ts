import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis.keys';
import { AtomicBudget } from '../redis/atomic-budget.service';
import { readDeliveryCoverage, readDeliveryRates } from './delivery.config';
import {
  COURIER_DELIVERY_UNAVAILABLE,
  DeliveryCoverage,
  DELIVERY_OUTSIDE_COVERAGE,
  isWithinCoverage,
} from './delivery-coverage';
import { DeliveryRates, priceRoute, tariffVersionOf } from './delivery-pricing';
import {
  ROUTING_PROVIDER,
  RouteNotFoundError,
  RoutingUnavailableError,
  toGeoPoint,
} from './routing/routing-provider';
// `import type` is required: with isolatedModules + emitDecoratorMetadata, a type used
// in a decorated signature must not be emitted as a value import.
import type { GeoPoint, RoutingProvider } from './routing/routing-provider';

/** What a client can tell these refusals by. The app words each one itself. */
export const DELIVERY_ADDRESS_REQUIRED = 'DELIVERY_ADDRESS_REQUIRED';
export const DELIVERY_ADDRESS_COORDINATES_MISSING =
  'DELIVERY_ADDRESS_COORDINATES_MISSING';
export const PICKUP_LOCATION_MISSING = 'PICKUP_LOCATION_MISSING';
export const DELIVERY_ROUTE_NOT_FOUND = 'DELIVERY_ROUTE_NOT_FOUND';
export const DELIVERY_ROUTING_UNAVAILABLE = 'DELIVERY_ROUTING_UNAVAILABLE';
export const DELIVERY_TOO_MANY_SELLERS = 'DELIVERY_TOO_MANY_SELLERS';
export const DELIVERY_QUOTE_LIMITED = 'DELIVERY_QUOTE_LIMITED';

/**
 * Sellers one quote may route to, and paid routing calls one buyer may cause per day.
 * Each seller in a cart is one route, so a real order needs a few. The daily figure
 * counts only uncached calls, and a buyer re-checking a cart reuses the cache.
 * Override with DELIVERY_MAX_SELLERS_PER_QUOTE and DELIVERY_ROUTING_DAILY_PER_USER.
 */
const DEFAULT_MAX_SELLERS_PER_QUOTE = 8;
const DEFAULT_ROUTING_DAILY_PER_USER = 100;
const DAY_S = 24 * 60 * 60;

/** Four decimals is about 10 m here: closer points are one route to the same price. */
function roundForRouteKey(coordinate: number): string {
  return coordinate.toFixed(4);
}

/**
 * Roads between two fixed points rarely change, and within this window a quote and the
 * order placed from it read the same answer, so the buyer pays what they were shown.
 */
const ROUTE_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** A cart or order line, as far as delivery cares. */
export interface DeliveryLine {
  partId: string | null;
  offerId: string | null;
  serviceId: string | null;
  offer?: { sellerTgId: string } | null;
}

/**
 * One seller's goods going to the buyer, as confirmed on the order. No duration or geometry
 * exists at this level at all. AccountDeletionService clears this with a buyer's other data.
 */
export interface DeliveryShipment {
  sellerId: number;
  pickup: GeoPoint;
  tariffVersion: string;
  distanceMeters: number;
  billableKm: number;
  priceUzs: number;
}

/**
 * Where the courier goes, as the saved address stood when this was quoted. An order keeps a
 * copy, because the buyer can edit or delete the address afterwards and the order must not
 * move with it. The point is exactly what the buyer chose; the words are only for reading.
 */
export interface DeliveryDestination extends GeoPoint {
  addressId: string;
  label: string | null;
  fullText: string;
  regionCode: string | null;
  district: string | null;
  street: string | null;
  landmark: string | null;
}

export interface DeliveryQuote {
  priceUzs: number;
  /** Null when there is nothing to deliver, so nothing to bind. See {@link deliveryQuoteId}. */
  quoteId: string | null;
  destination: DeliveryDestination | null;
  shipments: DeliveryShipment[];
}

const PICKUP_SELLER_SELECT = {
  id: true,
  tgId: true,
  catalogSellerId: true,
  locationLat: true,
  locationLng: true,
} as const;

/**
 * The supply-side seller behind a storefront, which is where the pickup location is kept.
 * An operator's explicit link wins, then the id the catalog projection recorded. Never
 * guessed from a name: no seller found means no pickup location.
 */
export function supplySellerOf<
  T extends { id: number; catalogSellerId: string | null },
>(
  sellers: readonly T[],
  catalogSellerId: string,
  internalSellerId: number | null,
): T | undefined {
  return (
    sellers.find((seller) => seller.catalogSellerId === catalogSellerId) ??
    sellers.find((seller) => seller.id === internalSellerId)
  );
}

/**
 * Names what a quote was for: the saved address, the exact point it held, each seller's
 * exact pickup point, and the rates. The buyer's agreement to a price is an agreement to
 * these, so order creation computes this again from the database and refuses the order if it
 * differs: the same price to a different place is not what they agreed to.
 *
 * A digest, not a signature, on purpose. The server only ever compares it with its own
 * result, so a client that worked one out would gain nothing it was not already entitled to,
 * and nothing about the points can be read back from it.
 */
export function deliveryQuoteId(
  destination: Pick<DeliveryDestination, 'addressId' | 'lat' | 'lng'>,
  shipments: readonly DeliveryShipment[],
): string {
  const legs = [...shipments]
    .sort((a, b) => a.sellerId - b.sellerId)
    .map((s) => [s.sellerId, s.pickup.lat, s.pickup.lng, s.tariffVersion]);
  return createHash('sha256')
    .update(
      JSON.stringify([
        destination.addressId,
        destination.lat,
        destination.lng,
        legs,
      ]),
    )
    .digest('hex');
}

/**
 * The price of courier delivery for a set of lines, computed here and nowhere else: the
 * quote the buyer sees and the charge on the order both come from this.
 *
 * Mator's couriers collect from each seller separately, and nothing else in the system
 * models a shipment. So each seller with goods in the cart is one route and one price, and
 * the buyer pays the sum. The order itself stays a single order.
 *
 * It refuses rather than guesses. Without both real coordinates and a real route there is
 * no price: no straight-line estimate, no flat fallback, and no zero. Without a configured
 * delivery area there are no couriers at all, whatever the address.
 */
@Injectable()
export class DeliveryQuoteService {
  private readonly logger = new Logger(DeliveryQuoteService.name);
  private readonly rates: DeliveryRates;
  private readonly tariffVersion: string;
  /** Null when no delivery area is configured, which keeps couriers off. */
  readonly coverage: DeliveryCoverage | null;
  private readonly maxSellersPerQuote: number;
  private readonly routingDailyPerUser: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(ROUTING_PROVIDER) private readonly routing: RoutingProvider,
    config: ConfigService,
    private readonly budget: AtomicBudget,
  ) {
    const positive = (name: string, fallback: number): number => {
      const value = Number(config.get<string>(name));
      return Number.isInteger(value) && value > 0 ? value : fallback;
    };
    this.maxSellersPerQuote = positive(
      'DELIVERY_MAX_SELLERS_PER_QUOTE',
      DEFAULT_MAX_SELLERS_PER_QUOTE,
    );
    this.routingDailyPerUser = positive(
      'DELIVERY_ROUTING_DAILY_PER_USER',
      DEFAULT_ROUTING_DAILY_PER_USER,
    );
    this.rates = readDeliveryRates((key) => config.get<string>(key));
    this.tariffVersion = tariffVersionOf(this.rates);
    this.coverage = readDeliveryCoverage((key) => config.get<string>(key));
    if (!this.coverage) {
      this.logger.warn(
        'DELIVERY_COVERAGE_POLYGON is not set: courier delivery is off, pickup still works.',
      );
    }
  }

  /** The quote for what is in the user's cart right now. */
  async quoteCart(
    userId: string,
    addressId: string | null | undefined,
  ): Promise<DeliveryQuote> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      select: {
        items: {
          select: {
            partId: true,
            offerId: true,
            serviceId: true,
            offer: { select: { sellerTgId: true } },
          },
        },
      },
    });
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }
    return this.quote(userId, addressId, cart.items);
  }

  /**
   * @throws NotFoundException when the address is not the user's own.
   * @throws UnprocessableEntityException when this delivery cannot be priced as asked.
   * @throws ServiceUnavailableException when the routing provider gave no answer.
   */
  async quote(
    userId: string,
    addressId: string | null | undefined,
    lines: readonly DeliveryLine[],
  ): Promise<DeliveryQuote> {
    if (!addressId) {
      throw new UnprocessableEntityException({
        code: DELIVERY_ADDRESS_REQUIRED,
        message: 'Courier delivery needs a delivery address.',
      });
    }
    const address = await this.prisma.address.findUnique({
      where: { id: addressId },
      select: {
        userId: true,
        lat: true,
        lng: true,
        label: true,
        fullText: true,
        regionCode: true,
        district: true,
        street: true,
        landmark: true,
      },
    });
    if (!address || address.userId !== userId) {
      throw new NotFoundException('Address not found');
    }

    // A line naming nothing counts as goods: its offer is gone, so it has no known pickup
    // and is refused below, rather than slipping through as nothing to deliver.
    const goods = lines.filter(
      (line) => line.partId || line.offerId || !line.serviceId,
    );
    if (goods.length === 0) {
      return { priceUzs: 0, quoteId: null, destination: null, shipments: [] };
    }

    if (!this.coverage) {
      throw new UnprocessableEntityException({
        code: COURIER_DELIVERY_UNAVAILABLE,
        message:
          'Courier delivery is not available yet. Choose pickup instead.',
      });
    }

    const point = toGeoPoint(address.lat, address.lng);
    if (!point) {
      throw new UnprocessableEntityException({
        code: DELIVERY_ADDRESS_COORDINATES_MISSING,
        message:
          'This delivery address has no location on the map, so courier delivery cannot be priced.',
      });
    }
    // Saving an address checks this too. Here it covers a row saved before the check
    // existed, and a delivery area narrowed since.
    if (!isWithinCoverage(point, this.coverage)) {
      throw new UnprocessableEntityException({
        code: DELIVERY_OUTSIDE_COVERAGE,
        message: 'This delivery address is outside the delivery area.',
      });
    }

    const pickups = await this.pickupsOf(goods);
    if (pickups.length > this.maxSellersPerQuote) {
      throw new UnprocessableEntityException({
        code: DELIVERY_TOO_MANY_SELLERS,
        message: 'This cart has goods from too many sellers for one courier delivery.',
      });
    }
    const shipments = await Promise.all(
      pickups.map(async ({ sellerId, origin }) => {
        const distanceMeters = await this.routeDistance(origin, point, userId);
        return {
          sellerId,
          pickup: origin,
          tariffVersion: this.tariffVersion,
          distanceMeters,
          ...priceRoute(distanceMeters, this.rates),
        };
      }),
    );
    const destination: DeliveryDestination = {
      addressId,
      ...point,
      label: address.label,
      fullText: address.fullText,
      regionCode: address.regionCode,
      district: address.district,
      street: address.street,
      landmark: address.landmark,
    };
    return {
      priceUzs: shipments.reduce((sum, shipment) => sum + shipment.priceUzs, 0),
      quoteId: deliveryQuoteId(destination, shipments),
      destination,
      shipments,
    };
  }

  /** Each seller with goods among these lines, and where to collect them from. */
  private async pickupsOf(
    goods: readonly DeliveryLine[],
  ): Promise<{ sellerId: number; origin: GeoPoint }[]> {
    const partIds = [
      ...new Set(goods.flatMap((line) => (line.partId ? [line.partId] : []))),
    ];
    const parts = partIds.length
      ? await this.prisma.catalogPart.findMany({
          where: { id: { in: partIds } },
          select: {
            id: true,
            sellerId: true,
            seller: { select: { internalSellerId: true } },
          },
        })
      : [];
    const partById = new Map(parts.map((part) => [part.id, part]));

    const offerTgIds = [
      ...new Set(
        goods.flatMap((line) =>
          line.offer && /^\d+$/.test(line.offer.sellerTgId)
            ? [line.offer.sellerTgId]
            : [],
        ),
      ),
    ];
    const sellers = await this.prisma.seller.findMany({
      where: {
        OR: [
          { catalogSellerId: { in: parts.map((part) => part.sellerId) } },
          {
            id: {
              in: parts.flatMap((part) =>
                part.seller.internalSellerId === null
                  ? []
                  : [part.seller.internalSellerId],
              ),
            },
          },
          { tgId: { in: offerTgIds.map((id) => BigInt(id)) } },
        ],
      },
      select: PICKUP_SELLER_SELECT,
    });

    const sellerOf = (line: DeliveryLine) => {
      const part = line.partId ? partById.get(line.partId) : undefined;
      if (part) {
        return supplySellerOf(
          sellers,
          part.sellerId,
          part.seller.internalSellerId,
        );
      }
      const tgId = line.offer?.sellerTgId;
      return tgId
        ? sellers.find((seller) => String(seller.tgId) === tgId)
        : undefined;
    };

    const unlocated: string[] = [];
    const pickups = new Map<number, GeoPoint>();
    for (const line of goods) {
      const seller = sellerOf(line);
      const origin = seller
        ? toGeoPoint(seller.locationLat, seller.locationLng)
        : null;
      if (seller && origin) pickups.set(seller.id, origin);
      else {
        unlocated.push(
          seller
            ? `seller ${seller.id}`
            : `no seller for line ${line.partId ?? line.offerId ?? '(gone)'}`,
        );
      }
    }
    if (unlocated.length > 0) {
      // For operators, who can fix this. The buyer learns only that it cannot be priced.
      this.logger.warn(
        `No pickup location to price delivery from: ${[...new Set(unlocated)].join('; ')}`,
      );
      throw new UnprocessableEntityException({
        code: PICKUP_LOCATION_MISSING,
        message:
          'A seller in this cart has no pickup location on record, so courier delivery cannot be priced.',
      });
    }
    return [...pickups].map(([sellerId, origin]) => ({ sellerId, origin }));
  }

  /**
   * The road distance, through the cache. Only an answer is cached: a failure propagates
   * out of `remember` unstored, so the next buyer asks the provider again. The key is a
   * hash because it would otherwise put a buyer's location into Redis and, through
   * CacheService's warnings, into the logs.
   */
  private async routeDistance(
    origin: GeoPoint,
    destination: GeoPoint,
    userId: string,
  ): Promise<number> {
    const id = createHash('sha256')
      .update(
        [
          this.routing.name,
          roundForRouteKey(origin.lat),
          roundForRouteKey(origin.lng),
          roundForRouteKey(destination.lat),
          roundForRouteKey(destination.lng),
        ].join('|'),
      )
      .digest('hex');
    try {
      const { distanceMeters } = await this.cache.remember(
        RedisKeys.cacheDeliveryRoute(id),
        ROUTE_CACHE_TTL_SECONDS,
        async () => {
          // Only a miss reaches here, so only paid calls are counted. A Redis
          // failure propagates: the cache may carry on without Redis, a paid call
          // may not.
          await this.reserveRoutingCall(userId);
          const distanceMeters = await this.routing.routeDistanceMeters(
            origin,
            destination,
          );
          // Checked here, whichever provider answered: once remembered, a bad value
          // would refuse every quote for this route until it expired.
          if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
            throw new RoutingUnavailableError(
              `${this.routing.name} gave an unusable distance`,
            );
          }
          return { distanceMeters };
        },
      );
      return distanceMeters;
    } catch (err) {
      if (err instanceof RouteNotFoundError) {
        this.logger.warn(`No route to price delivery from: ${err.message}`);
        throw new UnprocessableEntityException({
          code: DELIVERY_ROUTE_NOT_FOUND,
          message: 'No road route could be found to this delivery address.',
        });
      }
      if (err instanceof RoutingUnavailableError) {
        throw new ServiceUnavailableException({
          code: DELIVERY_ROUTING_UNAVAILABLE,
          message:
            'The delivery price cannot be calculated right now. Please try again shortly.',
        });
      }
      throw err;
    }
  }

  private async reserveRoutingCall(userId: string): Promise<void> {
    const decision = await this.budget.reserve([
      {
        key: RedisKeys.budgetRoutingDay(userId),
        limit: this.routingDailyPerUser,
        windowSeconds: DAY_S,
      },
    ]);
    if (decision.allowed) return;
    throw new HttpException(
      {
        code: DELIVERY_QUOTE_LIMITED,
        message: 'Too many delivery price requests today. Please try again later.',
        details: { retry_after_seconds: decision.retryAfter },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
