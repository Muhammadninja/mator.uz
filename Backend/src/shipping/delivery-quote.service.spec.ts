/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// What a courier delivery costs: from the cart and the saved address to a price. The
// routing provider is a stand-in, the cache is the real one over an in-memory Redis.

import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CacheService } from '../redis/cache.service';
import {
  createPrismaMock,
  fakeConfig,
  fakeRedis,
  PrismaMock,
  TEST_DELIVERY_COVERAGE,
} from '../../test/utils/harness';
import {
  COURIER_DELIVERY_UNAVAILABLE,
  DELIVERY_OUTSIDE_COVERAGE,
} from './delivery-coverage';
import { DEFAULT_DELIVERY_RATES, tariffVersionOf } from './delivery-pricing';
import {
  DELIVERY_ADDRESS_COORDINATES_MISSING,
  DELIVERY_ADDRESS_REQUIRED,
  DELIVERY_ROUTE_NOT_FOUND,
  DELIVERY_ROUTING_UNAVAILABLE,
  DeliveryLine,
  deliveryQuoteId,
  DeliveryQuoteService,
  DeliveryShipment,
  PICKUP_LOCATION_MISSING,
  supplySellerOf,
} from './delivery-quote.service';
import {
  RouteNotFoundError,
  RoutingUnavailableError,
  toGeoPoint,
} from './routing/routing-provider';

const USER = 'usr_1';
const ADDRESS = {
  userId: USER,
  lat: 41.3131,
  lng: 69.287,
  label: 'Work',
  fullText: 'Amir Temur 12, Toshkent',
  regionCode: 'UZ-TK',
  district: 'Yunusobod',
  street: 'Amir Temur 12',
  landmark: 'Blue gate',
};
const DESTINATION = {
  addressId: 'addr_1',
  lat: ADDRESS.lat,
  lng: ADDRESS.lng,
  label: 'Work',
  fullText: 'Amir Temur 12, Toshkent',
  regionCode: 'UZ-TK',
  district: 'Yunusobod',
  street: 'Amir Temur 12',
  landmark: 'Blue gate',
};
const TARIFF = tariffVersionOf(DEFAULT_DELIVERY_RATES);

const partLine = (partId: string): DeliveryLine => ({
  partId,
  offerId: null,
  serviceId: null,
  offer: null,
});
const offerLine = (sellerTgId: string): DeliveryLine => ({
  partId: null,
  offerId: `soff_${sellerTgId}`,
  serviceId: null,
  offer: { sellerTgId },
});
const serviceLine = (): DeliveryLine => ({
  partId: null,
  offerId: null,
  serviceId: 'svc_1',
  offer: null,
});

const seller = (over: Record<string, unknown> = {}) => ({
  id: 1,
  tgId: null,
  catalogSellerId: null,
  locationLat: 41.2995,
  locationLng: 69.2401,
  ...over,
});

describe('DeliveryQuoteService', () => {
  let prisma: PrismaMock;
  let redis: ReturnType<typeof fakeRedis>;
  let routing: { name: string; routeDistanceMeters: jest.Mock };
  let service: DeliveryQuoteService;

  const build = (env: Record<string, string> = {}) =>
    new DeliveryQuoteService(
      prisma,
      new CacheService(redis),
      routing,
      fakeConfig({ DELIVERY_COVERAGE_POLYGON: TEST_DELIVERY_COVERAGE, ...env }),
    );

  /** Parts `part_<seller>` belonging to the storefronts of the given sellers. */
  const stock = (...sellers: ReturnType<typeof seller>[]) => {
    prisma.catalogPart.findMany.mockResolvedValue(
      sellers.map((s) => ({
        id: `part_${s.id}`,
        sellerId: s.catalogSellerId ?? `seller_${s.id}`,
        seller: { internalSellerId: s.catalogSellerId ? null : s.id },
      })),
    );
    prisma.seller.findMany.mockResolvedValue(sellers);
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    redis = fakeRedis();
    routing = {
      name: 'test-provider',
      routeDistanceMeters: jest.fn().mockResolvedValue(7_300),
    };
    prisma.address.findUnique.mockResolvedValue(ADDRESS);
    service = build();
  });

  const refusal = async (promise: Promise<unknown>) =>
    (await promise.then(
      () => {
        throw new Error('expected a refusal');
      },
      (err: unknown) => err,
    )) as { getResponse: () => { code: string } };

  describe('a single seller', () => {
    it('prices the road distance from the seller to the saved address', async () => {
      stock(seller());

      const quote = await service.quote(USER, 'addr_1', [partLine('part_1')]);

      expect(routing.routeDistanceMeters).toHaveBeenCalledWith(
        { lat: 41.2995, lng: 69.2401 },
        { lat: 41.3131, lng: 69.287 },
      );
      expect(quote).toEqual({
        priceUzs: 24_000,
        quoteId: expect.stringMatching(/^[0-9a-f]{64}$/),
        destination: DESTINATION,
        shipments: [
          {
            sellerId: 1,
            pickup: { lat: 41.2995, lng: 69.2401 },
            tariffVersion: TARIFF,
            distanceMeters: 7_300,
            billableKm: 8,
            priceUzs: 24_000,
          },
        ],
      });
    });

    it('does not depend on quantity or on how many lines the seller has', async () => {
      stock(seller());
      prisma.catalogPart.findMany.mockResolvedValue([
        { id: 'a', sellerId: 'seller_1', seller: { internalSellerId: 1 } },
        { id: 'b', sellerId: 'seller_1', seller: { internalSellerId: 1 } },
      ]);

      const quote = await service.quote(USER, 'addr_1', [
        partLine('a'),
        partLine('b'),
      ]);

      expect(routing.routeDistanceMeters).toHaveBeenCalledTimes(1);
      expect(quote.priceUzs).toBe(24_000);
    });

    it('prices with the configured rates', async () => {
      stock(seller());
      routing.routeDistanceMeters.mockResolvedValue(1_500);
      const quote = await build({
        DELIVERY_TIER_PRICES_UZS: '1000,2000',
      }).quote(USER, 'addr_1', [partLine('part_1')]);
      expect(quote.priceUzs).toBe(2_000);
    });
  });

  describe('several sellers', () => {
    it('is one route and one price per seller, and the buyer pays the sum', async () => {
      stock(
        seller({ id: 1, locationLat: 41.1, locationLng: 69.1 }),
        seller({ id: 2, locationLat: 41.2, locationLng: 69.2 }),
      );
      routing.routeDistanceMeters.mockImplementation(
        ({ lat }: { lat: number }) =>
          Promise.resolve(lat === 41.1 ? 500 : 10_100),
      );

      const quote = await service.quote(USER, 'addr_1', [
        partLine('part_1'),
        partLine('part_2'),
      ]);

      expect(routing.routeDistanceMeters).toHaveBeenCalledTimes(2);
      expect(quote.priceUzs).toBe(5_000 + 32_500);
      expect(quote.shipments).toEqual([
        {
          sellerId: 1,
          pickup: { lat: 41.1, lng: 69.1 },
          tariffVersion: TARIFF,
          distanceMeters: 500,
          billableKm: 1,
          priceUzs: 5_000,
        },
        {
          sellerId: 2,
          pickup: { lat: 41.2, lng: 69.2 },
          tariffVersion: TARIFF,
          distanceMeters: 10_100,
          billableKm: 11,
          priceUzs: 32_500,
        },
      ]);
    });

    it('fails whole when any one shipment cannot be priced', async () => {
      stock(seller({ id: 1 }), seller({ id: 2, locationLat: 41.2 }));
      routing.routeDistanceMeters
        .mockResolvedValueOnce(500)
        .mockRejectedValueOnce(new RoutingUnavailableError('down'));

      await expect(
        service.quote(USER, 'addr_1', [partLine('part_1'), partLine('part_2')]),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('finding the pickup location', () => {
    it("reads a curated dealer's through its operator link", async () => {
      prisma.catalogPart.findMany.mockResolvedValue([
        {
          id: 'part_dv',
          sellerId: 'drivers-village',
          seller: { internalSellerId: null },
        },
      ]);
      prisma.seller.findMany.mockResolvedValue([
        seller({ id: 9, catalogSellerId: 'drivers-village' }),
      ]);

      const quote = await service.quote(USER, 'addr_1', [partLine('part_dv')]);

      expect(quote.shipments[0].sellerId).toBe(9);
    });

    it('reads an offer through the seller who made it', async () => {
      prisma.seller.findMany.mockResolvedValue([
        seller({ id: 5, tgId: BigInt(555) }),
      ]);

      const quote = await service.quote(USER, 'addr_1', [offerLine('555')]);

      expect(quote.shipments[0].sellerId).toBe(5);
    });

    it('prefers the explicit link when both could answer', () => {
      const linked = seller({ id: 2, catalogSellerId: 'dealer' });
      const recorded = seller({ id: 3 });
      expect(supplySellerOf([recorded, linked], 'dealer', 3)).toBe(linked);
      expect(supplySellerOf([recorded], 'dealer', 3)).toBe(recorded);
      expect(supplySellerOf([recorded], 'dealer', null)).toBeUndefined();
    });

    it.each<[string, () => void, DeliveryLine]>([
      [
        'the seller has no location',
        () => stock(seller({ locationLat: null, locationLng: null })),
        partLine('part_1'),
      ],
      [
        'the seller has half a location',
        () => stock(seller({ locationLng: null })),
        partLine('part_1'),
      ],
      [
        'the location is not a place',
        () => stock(seller({ locationLat: 91 })),
        partLine('part_1'),
      ],
      [
        'the location is 0,0',
        () => stock(seller({ locationLat: 0, locationLng: 0 })),
        partLine('part_1'),
      ],
      [
        'the storefront has no supply-side seller',
        () => {
          prisma.catalogPart.findMany.mockResolvedValue([
            { id: 'x', sellerId: 'demo', seller: { internalSellerId: null } },
          ]);
          prisma.seller.findMany.mockResolvedValue([]);
        },
        partLine('x'),
      ],
      ['the part no longer exists', () => undefined, partLine('gone')],
      [
        'the offer is gone',
        () => undefined,
        {
          partId: null,
          offerId: null,
          serviceId: null,
          offer: null,
        },
      ],
      [
        'the offer names no real seller id',
        () => undefined,
        offerLine('not-a-number'),
      ],
    ])(
      'refuses when %s: no route is asked for, no price is made up',
      async (_, arrange, line) => {
        arrange();

        const error = await refusal(service.quote(USER, 'addr_1', [line]));

        expect(error).toBeInstanceOf(UnprocessableEntityException);
        expect(error.getResponse().code).toBe(PICKUP_LOCATION_MISSING);
        expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
      },
    );
  });

  describe('the delivery address', () => {
    it.each([null, undefined, ''])('is required (%p)', async (addressId) => {
      const error = await refusal(
        service.quote(USER, addressId, [partLine('part_1')]),
      );
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse().code).toBe(DELIVERY_ADDRESS_REQUIRED);
    });

    it.each([
      ['does not exist', null],
      ["is someone else's", { ...ADDRESS, userId: 'usr_2' }],
    ])('404s when it %s', async (_, row) => {
      prisma.address.findUnique.mockResolvedValue(row);
      await expect(
        service.quote(USER, 'addr_1', [partLine('part_1')]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
    });

    it.each([
      ['has no coordinates', null, null],
      ['has half a pair', 41.3, null],
      ['has an impossible latitude', 95, 69.2],
      ['has an impossible longitude', 41.3, 190],
      ['has 0,0', 0, 0],
      ['has NaN', NaN, 69.2],
      ['has Infinity', 41.3, Infinity],
    ])(
      'refuses when it %s, with a code the app can act on',
      async (_, lat, lng) => {
        stock(seller());
        prisma.address.findUnique.mockResolvedValue({ ...ADDRESS, lat, lng });

        const error = await refusal(
          service.quote(USER, 'addr_1', [partLine('part_1')]),
        );

        expect(error).toBeInstanceOf(UnprocessableEntityException);
        expect(error.getResponse().code).toBe(
          DELIVERY_ADDRESS_COORDINATES_MISSING,
        );
        expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
      },
    );
  });

  describe('lines that are not delivered', () => {
    it('a cart of services alone costs nothing to deliver and needs no coordinates', async () => {
      prisma.address.findUnique.mockResolvedValue({
        ...ADDRESS,
        lat: null,
        lng: null,
      });

      await expect(
        service.quote(USER, 'addr_1', [serviceLine()]),
      ).resolves.toEqual({
        priceUzs: 0,
        quoteId: null,
        destination: null,
        shipments: [],
      });
      expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
    });

    it('a service beside goods adds no shipment', async () => {
      stock(seller());
      const quote = await service.quote(USER, 'addr_1', [
        partLine('part_1'),
        serviceLine(),
      ]);
      expect(quote.shipments).toHaveLength(1);
    });
  });

  describe('a provider that gives no price', () => {
    beforeEach(() => stock(seller()));
    const quote = () => service.quote(USER, 'addr_1', [partLine('part_1')]);

    it('no route is a 422 with its own code', async () => {
      routing.routeDistanceMeters.mockRejectedValue(
        new RouteNotFoundError('no route found'),
      );
      const error = await refusal(quote());
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse().code).toBe(DELIVERY_ROUTE_NOT_FOUND);
    });

    it('no answer is a 503 with its own code', async () => {
      routing.routeDistanceMeters.mockRejectedValue(
        new RoutingUnavailableError('down'),
      );
      const error = await refusal(quote());
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.getResponse().code).toBe(DELIVERY_ROUTING_UNAVAILABLE);
    });

    it.each([0, -1, NaN, Infinity])(
      'a distance of %p is never priced, and never remembered',
      async (distance) => {
        routing.routeDistanceMeters.mockResolvedValue(distance);
        const error = await refusal(quote());
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect(error.getResponse().code).toBe(DELIVERY_ROUTING_UNAVAILABLE);
        expect(redis.store.size).toBe(0);
      },
    );

    it('an unexpected fault stays visible as one', async () => {
      routing.routeDistanceMeters.mockRejectedValue(new TypeError('bug'));
      await expect(quote()).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe('what the buyer chose', () => {
    it('routes, prices and records the exact point saved, unrounded', async () => {
      stock(seller());
      const exact = { lat: 41.31310000049, lng: 69.28700000049 };
      prisma.address.findUnique.mockResolvedValue({ ...ADDRESS, ...exact });

      const quote = await service.quote(USER, 'addr_1', [partLine('part_1')]);

      expect(routing.routeDistanceMeters.mock.calls[0][1]).toEqual(exact);
      expect(quote.destination).toMatchObject(exact);
    });

    it('carries the words that went with the point, for the order to keep', async () => {
      stock(seller());
      const quote = await service.quote(USER, 'addr_1', [partLine('part_1')]);
      expect(quote.destination).toEqual(DESTINATION);
    });

    it('a pin with no words of its own is a whole destination', async () => {
      stock(seller());
      prisma.address.findUnique.mockResolvedValue({
        ...ADDRESS,
        label: null,
        fullText: '41.3131, 69.287',
        regionCode: null,
        district: null,
        street: null,
        landmark: null,
      });

      await expect(
        service.quote(USER, 'addr_1', [partLine('part_1')]),
      ).resolves.toMatchObject({ priceUzs: 24_000 });
    });

    it('a point far from the seller is priced like any other, and one next door too', async () => {
      stock(seller());
      prisma.address.findUnique.mockResolvedValue({
        ...ADDRESS,
        lat: 41.2995,
        lng: 69.24011,
      });
      routing.routeDistanceMeters.mockResolvedValue(10);

      await expect(
        service.quote(USER, 'addr_1', [partLine('part_1')]),
      ).resolves.toMatchObject({ priceUzs: 5_000 });
    });

    it('refuses a saved point outside the delivery area, without asking for a route', async () => {
      stock(seller());
      prisma.address.findUnique.mockResolvedValue({
        ...ADDRESS,
        lat: 55.75,
        lng: 37.61,
      });

      const error = await refusal(
        service.quote(USER, 'addr_1', [partLine('part_1')]),
      );

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse().code).toBe(DELIVERY_OUTSIDE_COVERAGE);
      expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
    });

    it('goes by the shape of the area, not the box around it', async () => {
      stock(seller());
      // A triangle: the destination is inside its box, and outside the triangle.
      const triangle = JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [69.0, 41.0],
            [70.0, 41.0],
            [69.0, 42.0],
            [69.0, 41.0],
          ],
        ],
      });
      prisma.address.findUnique.mockResolvedValue({
        ...ADDRESS,
        lat: 41.9,
        lng: 69.9,
      });

      const error = await refusal(
        build({ DELIVERY_COVERAGE_POLYGON: triangle }).quote(USER, 'addr_1', [
          partLine('part_1'),
        ]),
      );

      expect(error.getResponse().code).toBe(DELIVERY_OUTSIDE_COVERAGE);
    });
  });

  describe('with no delivery area configured', () => {
    const off = () =>
      build({ DELIVERY_COVERAGE_POLYGON: '' }).quote(USER, 'addr_1', [
        partLine('part_1'),
      ]);

    it('couriers are off, wherever the address is, and no route is asked for', async () => {
      stock(seller());

      const error = await refusal(off());

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error.getResponse().code).toBe(COURIER_DELIVERY_UNAVAILABLE);
      expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
    });

    it('whoever owns the address still decides who may ask about it', async () => {
      prisma.address.findUnique.mockResolvedValue({
        ...ADDRESS,
        userId: 'usr_2',
      });
      await expect(off()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a cart with nothing to deliver is still free', async () => {
      await expect(
        build({ DELIVERY_COVERAGE_POLYGON: '' }).quote(USER, 'addr_1', [
          serviceLine(),
        ]),
      ).resolves.toMatchObject({ priceUzs: 0 });
    });
  });

  describe('the quote id', () => {
    beforeEach(() => stock(seller()));
    const idFor = async (s = service, addressId = 'addr_1') =>
      (await s.quote(USER, addressId, [partLine('part_1')])).quoteId;
    const NEW_WORDS = {
      label: 'Home',
      fullText: 'Another way of saying it',
      street: 'Another street',
      landmark: 'Red door',
    };

    it('is stable while nothing it stands for changes', async () => {
      await expect(idFor()).resolves.toBe(await idFor());
    });

    it('changes when the buyer moves the saved destination', async () => {
      const before = await idFor();
      prisma.address.findUnique.mockResolvedValue({
        ...ADDRESS,
        lat: ADDRESS.lat + 0.0001,
      });
      await expect(idFor()).resolves.not.toBe(before);
    });

    it('does not change when only the words change: the place is the same', async () => {
      const before = await idFor();
      prisma.address.findUnique.mockResolvedValue({ ...ADDRESS, ...NEW_WORDS });
      await expect(idFor()).resolves.toBe(before);
    });

    it('changes when the seller moves the pickup point', async () => {
      const before = await idFor();
      stock(seller({ locationLat: 41.3 }));
      await expect(idFor()).resolves.not.toBe(before);
    });

    it('changes when the rates change, even if this trip costs the same', async () => {
      const before = await idFor();
      const after = await idFor(build({ DELIVERY_EXTRA_KM_PRICE_UZS: '9000' }));
      expect(after).not.toBe(before);
    });

    it('is another quote for another saved address at the very same point', async () => {
      await expect(idFor(service, 'addr_2')).resolves.not.toBe(await idFor());
    });

    it('does not depend on the order sellers are listed in', () => {
      const leg = (sellerId: number): DeliveryShipment => ({
        sellerId,
        pickup: { lat: 41 + sellerId, lng: 69 },
        tariffVersion: TARIFF,
        distanceMeters: 1,
        billableKm: 1,
        priceUzs: 5_000,
      });
      expect(deliveryQuoteId(DESTINATION, [leg(1), leg(2)])).toBe(
        deliveryQuoteId(DESTINATION, [leg(2), leg(1)]),
      );
    });

    it('says nothing about the points', async () => {
      const id = await idFor();
      expect(id).not.toContain('41.31');
      expect(id).not.toContain('69.28');
    });

    it('does not exist for a cart with nothing to deliver', async () => {
      const quote = await service.quote(USER, 'addr_1', [serviceLine()]);
      expect(quote).toEqual({
        priceUzs: 0,
        quoteId: null,
        destination: null,
        shipments: [],
      });
    });
  });

  describe('the route cache', () => {
    beforeEach(() => stock(seller()));
    const quote = (s = service) =>
      s.quote(USER, 'addr_1', [partLine('part_1')]);

    it('identical points ask the provider once, and the price stays the same', async () => {
      const first = await quote();
      const second = await quote();

      expect(routing.routeDistanceMeters).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('holds the distance for a day, and nothing but the distance', async () => {
      await quote();

      const [key] = [...redis.store.keys()];
      expect(key).toMatch(/^cache:delivery:route:[0-9a-f]{64}$/);
      expect(redis.ttls.get(key)).toBe(24 * 60 * 60);
      expect(await redis.get(key)).toEqual({ distanceMeters: 7_300 });
    });

    it('keeps no buyer location in the key', async () => {
      await quote();
      const [key] = [...redis.store.keys()];
      expect(key).not.toContain('41.31');
      expect(key).not.toContain('69.28');
    });

    it('another destination, or the reverse trip, is another route', async () => {
      await quote();
      prisma.address.findUnique.mockResolvedValue({ ...ADDRESS, lat: 41.32 });
      await quote();
      stock(seller({ locationLat: 41.32, locationLng: 69.287 }));
      prisma.address.findUnique.mockResolvedValue({
        ...ADDRESS,
        lat: 41.2995,
        lng: 69.2401,
      });
      await quote();

      expect(routing.routeDistanceMeters).toHaveBeenCalledTimes(3);
    });

    it("another provider does not read the old one's answers", async () => {
      await quote();
      routing.name = 'other-provider';
      await quote();
      expect(routing.routeDistanceMeters).toHaveBeenCalledTimes(2);
    });

    it('a failure is not remembered: the next buyer asks again', async () => {
      routing.routeDistanceMeters.mockRejectedValueOnce(
        new RoutingUnavailableError('down'),
      );
      await expect(quote()).rejects.toBeInstanceOf(ServiceUnavailableException);

      await expect(quote()).resolves.toMatchObject({ priceUzs: 24_000 });
      expect(routing.routeDistanceMeters).toHaveBeenCalledTimes(2);
    });

    it('with Redis down the quote still works, straight from the provider', async () => {
      const broken = {
        get: jest.fn().mockRejectedValue(new Error('redis down')),
        setEx: jest.fn().mockRejectedValue(new Error('redis down')),
      };
      const uncached = new DeliveryQuoteService(
        prisma,
        new CacheService(broken as never),
        routing,
        fakeConfig({ DELIVERY_COVERAGE_POLYGON: TEST_DELIVERY_COVERAGE }),
      );

      await expect(quote(uncached)).resolves.toMatchObject({
        priceUzs: 24_000,
      });
    });
  });

  describe('quoteCart', () => {
    it('prices what the server cart holds, ignoring anything the client might claim', async () => {
      stock(seller());
      prisma.cart.findUnique.mockResolvedValue({
        items: [{ ...partLine('part_1') }],
      });

      await expect(service.quoteCart(USER, 'addr_1')).resolves.toMatchObject({
        priceUzs: 24_000,
      });
      expect(prisma.cart.findUnique.mock.calls[0][0].where).toEqual({
        userId: USER,
      });
    });

    it.each([
      ['no cart', null],
      ['an empty cart', { items: [] }],
    ])('with %s there is nothing to price', async (_, cart) => {
      prisma.cart.findUnique.mockResolvedValue(cart);
      await expect(service.quoteCart(USER, 'addr_1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});

describe('toGeoPoint', () => {
  it('keeps the coordinates exactly as stored', () => {
    expect(toGeoPoint(41.31310000049, 69.28700000049)).toEqual({
      lat: 41.31310000049,
      lng: 69.28700000049,
    });
  });

  it('accepts the extremes of the range', () => {
    expect(toGeoPoint(90, 180)).toEqual({ lat: 90, lng: 180 });
    expect(toGeoPoint(-90, -180)).toEqual({ lat: -90, lng: -180 });
    expect(toGeoPoint(0, 69.2)).toEqual({ lat: 0, lng: 69.2 });
  });

  it.each([
    [null, 1],
    [1, null],
    [undefined, 1],
    [90.1, 1],
    [1, 180.1],
    [-90.1, 1],
    [NaN, 1],
    [1, Infinity],
    [0, 0],
    ['41.3', '69.2'],
  ])('names no point for (%p, %p)', (lat, lng) => {
    expect(toGeoPoint(lat as number, lng as number)).toBeNull();
  });
});
