/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the Prisma harness (test/utils/harness.ts) and supertest bodies are untyped by design */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AddressesModule } from '../../src/addresses/addresses.module';
import {
  ADDRESS_SEARCH_PROVIDER,
  AddressSearchUnavailableError,
} from '../../src/addresses/search/address-search-provider';
import {
  REVERSE_GEOCODING_PROVIDER,
  ReverseGeocodingUnavailableError,
} from '../../src/addresses/search/reverse-geocoding-provider';
import { UzmapsReverseGeocodingProvider } from '../../src/addresses/search/uzmaps-reverse-geocoding.provider';
import { UzmapsAddressSearchProvider } from '../../src/addresses/search/uzmaps-address-search.provider';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { OrdersModule } from '../../src/orders/orders.module';
import { OrdersService } from '../../src/orders/orders.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisModule } from '../../src/redis/redis.module';
import { RedisService } from '../../src/redis/redis.service';
import { DeliveryQuoteService } from '../../src/shipping/delivery-quote.service';
import {
  ROUTING_PROVIDER,
  RouteNotFoundError,
  RoutingUnavailableError,
} from '../../src/shipping/routing/routing-provider';
import { UzmapsRoutingProvider } from '../../src/shipping/routing/uzmaps-routing.provider';
import { ShippingModule } from '../../src/shipping/shipping.module';
import {
  createPrismaMock,
  FakeQueueModule,
  fakeRedis,
  PrismaMock,
  TEST_DELIVERY_COVERAGE,
} from '../utils/harness';

/**
 * POST /v1/shipping/quote through the real DI graph, validation pipe and exception filter,
 * with only the database, Redis and the routing provider standing in. The DI graph is the
 * point of the first test: UzMaps is bound to a symbol, and OrdersModule reaches the quote
 * service through ShippingModule's export.
 */
const GLOBALS = (coverage: string | undefined = TEST_DELIVERY_COVERAGE) => [
  ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    // Read by the Redis client provider. It connects lazily, and RedisService is replaced.
    load: [
      () => ({
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '1',
        DELIVERY_COVERAGE_POLYGON: coverage,
      }),
    ],
  }),
  PrismaModule,
  RedisModule,
  FakeQueueModule,
];

describe('POST /v1/shipping/quote (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let routing: { name: string; routeDistanceMeters: jest.Mock };

  beforeAll(async () => {
    prisma = createPrismaMock();
    routing = { name: 'test-provider', routeDistanceMeters: jest.fn() };
    const mod = await Test.createTestingModule({
      imports: [...GLOBALS(), ShippingModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(routing)
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { id: 'usr_1' };
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const cartWithSeller = (lat: number | null) => {
    prisma.address.findUnique.mockResolvedValue({
      userId: 'usr_1',
      lat: 41.3131,
      lng: 69.287,
    });
    prisma.cart.findUnique.mockResolvedValue({
      items: [
        { partId: 'part_1', offerId: null, serviceId: null, offer: null },
      ],
    });
    prisma.catalogPart.findMany.mockResolvedValue([
      { id: 'part_1', sellerId: 'seller_1', seller: { internalSellerId: 1 } },
    ]);
    prisma.seller.findMany.mockResolvedValue([
      {
        id: 1,
        tgId: null,
        catalogSellerId: null,
        locationLat: lat,
        locationLng: 69.2401,
      },
    ]);
  };

  const post = (body: object) =>
    request(app.getHttpServer()).post('/v1/shipping/quote').send(body);
  const COURIER = { delivery_address_id: 'addr_1', delivery_method: 'courier' };

  beforeEach(() => {
    routing.routeDistanceMeters.mockReset();
  });

  it('answers a courier quote with the price alone', async () => {
    cartWithSeller(41.2995);
    routing.routeDistanceMeters.mockResolvedValue(7300);

    const res = await post(COURIER).expect(200);

    expect(res.body).toEqual({
      options: [
        {
          type: 'courier',
          label: 'Kuryer',
          price_uzs: 24000,
          quote_id: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
      currency: 'UZS',
    });
  });

  it('gives the box around the delivery area', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/shipping/coverage')
      .expect(200);

    expect(res.body).toMatchObject({
      configured: true,
      bounds: { min_lat: 37, min_lng: 55, max_lat: 46, max_lng: 74 },
      geometry: { type: 'MultiPolygon' },
    });
  });

  it('answers an installed build as it always has', async () => {
    const res = await post({ delivery_address_id: 'addr_1' }).expect(200);

    expect(res.body.options.map((o: any) => o.type)).toEqual(['pickup']);
    expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
  });

  it('422 with a code for a seller with no pickup location', async () => {
    cartWithSeller(null);

    const res = await post(COURIER).expect(422);

    expect(res.body.code).toBe('PICKUP_LOCATION_MISSING');
    expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
  });

  it('422 with a code for an address with no coordinates', async () => {
    cartWithSeller(41.2995);
    prisma.address.findUnique.mockResolvedValue({
      userId: 'usr_1',
      lat: null,
      lng: null,
    });

    const res = await post(COURIER).expect(422);

    expect(res.body.code).toBe('DELIVERY_ADDRESS_COORDINATES_MISSING');
    expect(res.body.message).toEqual(expect.any(String));
  });

  it('422 with a code for an address outside the delivery area', async () => {
    cartWithSeller(41.2995);
    prisma.address.findUnique.mockResolvedValue({
      userId: 'usr_1',
      lat: 55.75,
      lng: 37.61,
    });

    const res = await post(COURIER).expect(422);

    expect(res.body.code).toBe('DELIVERY_OUTSIDE_COVERAGE');
    expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
  });

  it('422 with a code when courier is asked for without an address', async () => {
    cartWithSeller(41.2995);

    const res = await post({ delivery_method: 'courier' }).expect(422);

    expect(res.body.code).toBe('DELIVERY_ADDRESS_REQUIRED');
  });

  it('422 with a code when no road reaches the address', async () => {
    cartWithSeller(41.11);
    routing.routeDistanceMeters.mockRejectedValue(
      new RouteNotFoundError('no route found'),
    );

    const res = await post(COURIER).expect(422);

    expect(res.body.code).toBe('DELIVERY_ROUTE_NOT_FOUND');
  });

  it('503 with a code when the provider gives no answer, naming no internals', async () => {
    cartWithSeller(41.12);
    routing.routeDistanceMeters.mockRejectedValue(
      new RoutingUnavailableError('UzMaps answered 401: unknown API key'),
    );

    const res = await post(COURIER).expect(503);

    expect(res.body.code).toBe('DELIVERY_ROUTING_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/uzmaps|api key/i);
  });

  it("404 for an address that is not the caller's", async () => {
    cartWithSeller(41.2995);
    prisma.address.findUnique.mockResolvedValue({
      userId: 'usr_2',
      lat: 41.3,
      lng: 69.2,
    });

    await post(COURIER).expect(404);
    expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
  });

  it.each([
    [{ destination: { lat: 41.3, lng: 69.2 } }],
    [{ price_uzs: 1 }],
    [{ delivery_method: 'teleport' }],
  ])('400 for a body stating %j', async (body) => {
    await post(body).expect(400);
  });
});

describe('With no delivery area configured (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let routing: { name: string; routeDistanceMeters: jest.Mock };

  beforeAll(async () => {
    prisma = createPrismaMock();
    routing = { name: 'test-provider', routeDistanceMeters: jest.fn() };
    const mod = await Test.createTestingModule({
      imports: [...GLOBALS(''), ShippingModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(routing)
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { id: 'usr_1' };
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a courier is refused with a code, and no route is asked for', async () => {
    prisma.address.findUnique.mockResolvedValue({
      userId: 'usr_1',
      lat: 41.3131,
      lng: 69.287,
    });
    prisma.cart.findUnique.mockResolvedValue({
      items: [
        { partId: 'part_1', offerId: null, serviceId: null, offer: null },
      ],
    });

    const res = await request(app.getHttpServer())
      .post('/v1/shipping/quote')
      .send({ delivery_address_id: 'addr_1', delivery_method: 'courier' })
      .expect(422);

    expect(res.body.code).toBe('COURIER_DELIVERY_UNAVAILABLE');
    expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
  });

  it('pickup still answers', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/shipping/quote')
      .send({ delivery_address_id: 'addr_1' })
      .expect(200);

    expect(res.body.options.map((o: any) => o.type)).toEqual(['pickup']);
  });

  it('says so, naming no place', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/shipping/coverage')
      .expect(200);

    expect(res.body).toEqual({
      configured: false,
      bounds: null,
      geometry: null,
    });
  });
});

describe('Saving and searching addresses (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let search: {
    attribution: string;
    search: jest.Mock;
  };
  let reverse: {
    attribution: string;
    describe: jest.Mock;
  };

  const ROW = {
    id: 'addr_1',
    userId: 'usr_1',
    label: null,
    regionCode: null,
    district: null,
    street: null,
    isDefault: true,
    createdAt: new Date('2026-11-05T10:00:00.000Z'),
    updatedAt: new Date('2026-11-05T10:00:00.000Z'),
  };

  beforeAll(async () => {
    prisma = createPrismaMock();
    search = { attribution: 'credit', search: jest.fn() };
    reverse = { attribution: 'map credit', describe: jest.fn() };
    const mod = await Test.createTestingModule({
      imports: [...GLOBALS(), AddressesModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .overrideProvider(ADDRESS_SEARCH_PROVIDER)
      .useValue(search)
      .overrideProvider(REVERSE_GEOCODING_PROVIDER)
      .useValue(reverse)
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { id: 'usr_1' };
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    search.search.mockReset();
    reverse.describe.mockReset();
    prisma.address.count.mockResolvedValue(0);
    prisma.address.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...ROW, ...data }),
    );
  });

  const save = (body: object) =>
    request(app.getHttpServer()).post('/v1/addresses').send(body);
  const suggest = (query: string) =>
    request(app.getHttpServer()).get(`/v1/addresses/suggestions?${query}`);

  it('saves a pin with no street address, at exactly the point chosen', async () => {
    const res = await save({ lat: 41.311081234, lng: 69.240562987 }).expect(
      201,
    );

    expect(res.body).toMatchObject({
      lat: 41.311081234,
      lng: 69.240562987,
      full_text: '41.311081234, 69.240562987',
    });
  });

  it('keeps a hint for the courier with the pin', async () => {
    const res = await save({
      lat: 41.31,
      lng: 69.24,
      landmark: 'Blue gate, second entrance',
    }).expect(201);

    expect(res.body.landmark).toBe('Blue gate, second entrance');
  });

  it('refuses a hint too long to be one', async () => {
    await save({ lat: 41.31, lng: 69.24, landmark: 'x'.repeat(201) }).expect(
      400,
    );
  });

  it.each([
    ['half a pair', { full_text: 'Navoi 1', lat: 41.3 }, 400],
    ['0,0', { full_text: 'Navoi 1', lat: 0, lng: 0 }, 400],
    ['neither text nor a point', { label: 'Home' }, 400],
    ['a latitude out of range', { lat: 91, lng: 69 }, 400],
    ['a longitude out of range', { lat: 41, lng: 181 }, 400],
    ['a latitude that is not a number', { lat: '41.3', lng: 69 }, 400],
    ['a point outside the delivery area', { lat: 55.75, lng: 37.61 }, 422],
  ])('refuses %s', async (_, body, status) => {
    await save(body).expect(status);
    expect(prisma.address.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(body) }),
    );
  });

  it('answers a search with the matches, each with its point, in the buyer language', async () => {
    search.search.mockResolvedValue([
      {
        id: '1',
        title: 'Amir Temur 12',
        subtitle: 'Toshkent',
        city: 'Toshkent',
        district: null,
        street: 'Amir Temur',
        house: '12',
        lat: 41.31,
        lng: 69.28,
      },
    ]);

    const res = await suggest('street=Amir%20Temur&house=12&lang=ru').expect(
      200,
    );

    expect(search.search).toHaveBeenCalledWith(
      expect.objectContaining({
        street: 'Amir Temur',
        house: '12',
        language: 'ru',
      }),
    );
    expect(res.body).toEqual({
      items: [
        {
          id: '1',
          title: 'Amir Temur 12',
          subtitle: 'Toshkent',
          city: 'Toshkent',
          district: null,
          street: 'Amir Temur',
          house_number: '12',
          lat: 41.31,
          lng: 69.28,
        },
      ],
      attribution: 'credit',
    });
  });

  it('takes a submitted search and where the map is looking', async () => {
    search.search.mockResolvedValue([]);

    await suggest(
      'street=Navoiy%20submitted&mode=search&near_lat=41.3&near_lng=69.2',
    ).expect(200);

    expect(search.search).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'search',
        near: { lat: 41.3, lng: 69.2 },
      }),
    );
  });

  describe('GET /v1/addresses/reverse', () => {
    const point = (query: string) =>
      request(app.getHttpServer()).get(`/v1/addresses/reverse?${query}`);

    it('says what is at a point, reading its numbers from the query', async () => {
      reverse.describe.mockResolvedValue({
        city: 'Toshkent',
        district: null,
        street: 'Seul',
        house: null,
      });

      const res = await point('lat=41.2995&lng=69.2401&lang=en').expect(200);

      expect(reverse.describe).toHaveBeenCalledWith(
        { lat: 41.2995, lng: 69.2401 },
        'en',
      );
      expect(res.body).toEqual({
        address: {
          city: 'Toshkent',
          district: null,
          street: 'Seul',
          house_number: null,
        },
        within_coverage: true,
        attribution: 'map credit',
      });
    });

    it('still answers when the provider does not', async () => {
      reverse.describe.mockRejectedValue(
        new ReverseGeocodingUnavailableError('UzMaps answered 401'),
      );

      const res = await point('lat=41.3001&lng=69.2402').expect(200);

      expect(res.body).toEqual({
        address: null,
        within_coverage: true,
        attribution: null,
      });
    });

    it.each([
      ['no point', ''],
      ['half a point', 'lat=41.3'],
      ['a point in words', 'lat=north&lng=69'],
      ['a latitude out of range', 'lat=91&lng=69'],
      ['0,0', 'lat=0&lng=0'],
    ])('400 for %s', async (_, query) => {
      await point(query).expect(400);
      expect(reverse.describe).not.toHaveBeenCalled();
    });
  });

  it('503 with a code when the search provider gives no answer, naming no internals', async () => {
    search.search.mockRejectedValue(
      new AddressSearchUnavailableError('UzMaps answered 401: unknown API key'),
    );

    const res = await suggest('street=Amir').expect(503);

    expect(res.body.code).toBe('ADDRESS_SEARCH_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/uzmaps|api key/i);
  });

  it.each([
    ['no street', 'house=12'],
    ['too little to search for', 'street=A'],
    ['an unknown language', 'street=Amir&lang=fr'],
    ['coordinates of its own', 'street=Amir&lat=41'],
  ])('400 for a search with %s', async (_, query) => {
    await suggest(query).expect(400);
    expect(search.search).not.toHaveBeenCalled();
  });
});

describe('Delivery wiring', () => {
  it('in production the provider bound to the token is UzMaps', async () => {
    const mod = await Test.createTestingModule({
      imports: [...GLOBALS(), ShippingModule],
    })
      .overrideProvider(PrismaService)
      .useValue(createPrismaMock())
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .compile();

    expect(mod.get(ROUTING_PROVIDER)).toBeInstanceOf(UzmapsRoutingProvider);
    expect(mod.get(DeliveryQuoteService)).toBeInstanceOf(DeliveryQuoteService);
    await mod.close();
  });

  it('search and reverse geocoding are each bound on their own', async () => {
    const mod = await Test.createTestingModule({
      imports: [...GLOBALS(), AddressesModule],
    })
      .overrideProvider(PrismaService)
      .useValue(createPrismaMock())
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .compile();

    expect(mod.get(ADDRESS_SEARCH_PROVIDER)).toBeInstanceOf(
      UzmapsAddressSearchProvider,
    );
    expect(mod.get(REVERSE_GEOCODING_PROVIDER)).toBeInstanceOf(
      UzmapsReverseGeocodingProvider,
    );
    await mod.close();
  });

  it('OrdersModule reaches the quote service through the module graph', async () => {
    const mod = await Test.createTestingModule({
      imports: [...GLOBALS(), OrdersModule],
    })
      .overrideProvider(PrismaService)
      .useValue(createPrismaMock())
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .compile();

    expect(mod.get(OrdersService, { strict: false })).toBeInstanceOf(
      OrdersService,
    );
    await mod.close();
  });
});
