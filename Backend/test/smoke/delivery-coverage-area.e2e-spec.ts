/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the Prisma harness (test/utils/harness.ts) and supertest bodies are untyped by design */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { parse } from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { AddressesModule } from '../../src/addresses/addresses.module';
import { ADDRESS_SEARCH_PROVIDER } from '../../src/addresses/search/address-search-provider';
import { REVERSE_GEOCODING_PROVIDER } from '../../src/addresses/search/reverse-geocoding-provider';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisModule } from '../../src/redis/redis.module';
import { RedisService } from '../../src/redis/redis.service';
import { ROUTING_PROVIDER } from '../../src/shipping/routing/routing-provider';
import { ShippingModule } from '../../src/shipping/shipping.module';
import {
  createPrismaMock,
  FakeQueueModule,
  fakeRedis,
  PrismaMock,
} from '../utils/harness';

/**
 * The approved area through the real DI graph, pipe and filter, configured by the real env
 * line: Tashkent City and New Tashkent, and the coordinates a buyer could actually send. Only
 * the database, Redis and the UzMaps providers stand in.
 */
const DIR = join(__dirname, '../../config/delivery-coverage');
const { DELIVERY_COVERAGE_POLYGON } = parse(
  readFileSync(join(DIR, 'delivery-coverage.env.txt')),
);

const CHILONZOR = { lat: 41.2995, lng: 69.2401 };
const ULUGBEK_SETTLEMENT = { lat: 41.41169, lng: 69.45394 };
const NEW_TASHKENT = { lat: 41.240701, lng: 69.449366 };
const JUST_INSIDE = { lat: 41.370975, lng: 69.320214 };
const JUST_OUTSIDE = { lat: 41.372767, lng: 69.326983 };
const OLD_POLYGON_WEDGE = { lat: 41.343404, lng: 69.468082 };
const CHIRCHIQ = { lat: 41.4689, lng: 69.5822 };
const KELES = { lat: 41.4033, lng: 69.22 };

describe('Delivery to Tashkent City and New Tashkent only (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let routing: { name: string; routeDistanceMeters: jest.Mock };
  let search: { attribution: string; search: jest.Mock };
  let reverse: { attribution: string; describe: jest.Mock };

  beforeAll(async () => {
    prisma = createPrismaMock();
    routing = {
      name: 'test-provider',
      routeDistanceMeters: jest.fn().mockResolvedValue(7_300),
    };
    search = { attribution: 'credit', search: jest.fn() };
    reverse = {
      attribution: 'credit',
      describe: jest.fn().mockResolvedValue(null),
    };
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              REDIS_HOST: '127.0.0.1',
              REDIS_PORT: '1',
              DELIVERY_COVERAGE_POLYGON,
            }),
          ],
        }),
        PrismaModule,
        RedisModule,
        FakeQueueModule,
        ShippingModule,
        AddressesModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(routing)
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
    routing.routeDistanceMeters.mockClear();
    search.search.mockReset();
    reverse.describe.mockClear();
    prisma.address.count.mockResolvedValue(1);
    prisma.address.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'addr_1',
          userId: 'usr_1',
          label: null,
          regionCode: null,
          district: null,
          street: null,
          landmark: null,
          isDefault: false,
          createdAt: new Date('2026-11-05T10:00:00.000Z'),
          updatedAt: new Date('2026-11-05T10:00:00.000Z'),
          ...data,
        }),
    );
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
        locationLat: 41.2995,
        locationLng: 69.2401,
      },
    ]);
  });

  const addressAt = (point: { lat: number; lng: number }) =>
    prisma.address.findUnique.mockResolvedValue({
      userId: 'usr_1',
      fullText: 'Somewhere',
      ...point,
    });
  const courierQuote = () =>
    request(app.getHttpServer())
      .post('/v1/shipping/quote')
      .send({ delivery_address_id: 'addr_1', delivery_method: 'courier' });
  const courierOf = (body: any) =>
    body.options.find((option: any) => option.type === 'courier');

  describe('what the app is told', () => {
    it('the geometry the backend enforces, and the box around it', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/shipping/coverage')
        .expect(200);

      expect(res.body.configured).toBe(true);
      expect(res.body.bounds).toEqual({
        min_lat: 41.1577334,
        min_lng: 69.121856,
        max_lat: 41.3984299,
        max_lng: 69.525908,
      });
      expect(res.body.geometry).toEqual(JSON.parse(DELIVERY_COVERAGE_POLYGON));
    });
  });

  describe('saving a delivery point', () => {
    const save = (point: object) =>
      request(app.getHttpServer()).post('/v1/addresses').send(point);

    it.each([
      ['in Chilonzor', CHILONZOR],
      ['in New Tashkent', NEW_TASHKENT],
      ['300 m inside the boundary', JUST_INSIDE],
    ])('accepts a point %s', async (_, point) => {
      await save(point).expect(201);
    });

    it.each([
      ['300 m outside the boundary, in the region', JUST_OUTSIDE],
      ['in the wedge the old polygon wrongly covered', OLD_POLYGON_WEDGE],
      [
        'in the detached Ulugbek settlement, left out by decision',
        ULUGBEK_SETTLEMENT,
      ],
      ['in Keles, Tashkent Region', KELES],
      ['in Chirchiq, Tashkent Region', CHIRCHIQ],
    ])('refuses a point %s', async (_, point) => {
      const res = await save(point).expect(422);
      expect(res.body.code).toBe('DELIVERY_OUTSIDE_COVERAGE');
    });
  });

  describe('a courier quote', () => {
    it.each([
      ['in Chilonzor', CHILONZOR],
      ['in New Tashkent', NEW_TASHKENT],
      ['300 m inside the boundary', JUST_INSIDE],
    ])('prices an address %s', async (_, point) => {
      addressAt(point);
      const res = await courierQuote().expect(200);
      expect(courierOf(res.body)).toMatchObject({
        available: true,
        price_uzs: 24_000,
      });
    });

    it.each([
      ['300 m outside the boundary, in the region', JUST_OUTSIDE],
      ['in Keles, Tashkent Region', KELES],
      ['in Chirchiq, Tashkent Region', CHIRCHIQ],
    ])('refuses an address %s, without a paid route', async (_, point) => {
      addressAt(point);

      const res = await courierQuote().expect(200);

      expect(courierOf(res.body)).toMatchObject({
        available: false,
        price_uzs: null,
        unavailable_reason: { code: 'DELIVERY_OUTSIDE_COVERAGE' },
      });
      // Pickup is still there for the buyer to take.
      expect(res.body.options[0]).toMatchObject({
        type: 'pickup',
        available: true,
      });
      expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
    });
  });

  it('pickup is allowed wherever the address is', async () => {
    addressAt(CHIRCHIQ);

    const res = await request(app.getHttpServer())
      .post('/v1/shipping/quote')
      .send({ delivery_address_id: 'addr_1', delivery_method: 'pickup' })
      .expect(200);

    expect(res.body.options.map((option: any) => option.type)).toEqual([
      'pickup',
    ]);
    expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
  });

  describe('what the buyer is told about a point', () => {
    const point = ({ lat, lng }: { lat: number; lng: number }) =>
      request(app.getHttpServer()).get(
        `/v1/addresses/reverse?lat=${lat}&lng=${lng}`,
      );

    it('in New Tashkent: covered', async () => {
      const res = await point(NEW_TASHKENT).expect(200);
      expect(res.body.within_coverage).toBe(true);
    });

    it('inside the city: covered', async () => {
      const res = await point(CHILONZOR).expect(200);
      expect(res.body.within_coverage).toBe(true);
    });

    it('in the region: not covered, and no paid lookup is spent on it', async () => {
      const res = await point(KELES).expect(200);
      expect(res.body.within_coverage).toBe(false);
      expect(reverse.describe).not.toHaveBeenCalled();
    });
  });

  it('address search offers nothing outside the area, and looks only around it', async () => {
    const found = (id: string, at: { lat: number; lng: number }) => ({
      id,
      title: id,
      subtitle: null,
      city: null,
      district: null,
      street: null,
      house: null,
      ...at,
    });
    search.search.mockResolvedValue([
      found('in the city', CHILONZOR),
      found('in the region', KELES),
    ]);

    const res = await request(app.getHttpServer())
      .get('/v1/addresses/suggestions?street=Amir')
      .expect(200);

    expect(res.body.items.map((item: any) => item.id)).toEqual(['in the city']);
    expect(search.search.mock.calls[0][0].bounds).toEqual({
      minLng: 69.121856,
      minLat: 41.1577334,
      maxLng: 69.525908,
      maxLat: 41.3984299,
    });
  });
});
