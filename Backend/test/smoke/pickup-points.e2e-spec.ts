/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the Prisma harness (test/utils/harness.ts) and supertest bodies are untyped by design */
// GET /v1/shipping/pickup-points through the real DI graph, guard wiring and exception filter,
// with only the database and Redis standing in: where the buyer collects each dealer's goods.

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
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

describe('GET /v1/shipping/pickup-points (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaMock;
  let routing: { name: string; routeDistanceMeters: jest.Mock };

  beforeAll(async () => {
    prisma = createPrismaMock();
    routing = { name: 'test-provider', routeDistanceMeters: jest.fn() };
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ REDIS_HOST: '127.0.0.1', REDIS_PORT: '1' })],
        }),
        PrismaModule,
        RedisModule,
        FakeQueueModule,
        ShippingModule,
      ],
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

  const get = () =>
    request(app.getHttpServer()).get('/v1/shipping/pickup-points');

  it("lists each dealer in the caller's cart once, with its own lines and place", async () => {
    prisma.cart.findUnique.mockResolvedValue({
      items: [
        {
          id: 'ci_1',
          partId: 'part_1',
          offerId: null,
          serviceId: null,
          title: 'Kolodka',
          quantity: 2,
          offer: null,
        },
        {
          id: 'ci_2',
          partId: 'part_2',
          offerId: null,
          serviceId: null,
          title: 'Filtr',
          quantity: 1,
          offer: null,
        },
      ],
    });
    prisma.catalogPart.findMany.mockResolvedValue([
      { id: 'part_1', sellerId: 'seller_1' },
      { id: 'part_2', sellerId: 'seller_1' },
    ]);
    prisma.catalogSeller.findMany.mockResolvedValue([
      { id: 'seller_1', name: 'Avto Ehtiyot', internalSellerId: 1 },
    ]);
    prisma.seller.findMany.mockResolvedValue([
      {
        id: 1,
        tgId: null,
        catalogSellerId: null,
        storeName: 'Avto Ehtiyot',
        marketName: null,
        addressComment: 'Sergeli avtobozori, 3-qator 25',
        locationLat: 41.2263,
        locationLng: 69.219,
      },
    ]);

    const res = await get().expect(200);

    expect(prisma.cart.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'usr_1' } }),
    );
    expect(res.body).toEqual({
      pickup_points: [
        {
          dealer_id: 'seller_1',
          dealer_name: 'Avto Ehtiyot',
          address: 'Sergeli avtobozori, 3-qator 25',
          landmark: null,
          location: { lat: 41.2263, lng: 69.219 },
          items: [
            {
              cart_item_id: 'ci_1',
              part_id: 'part_1',
              title: 'Kolodka',
              quantity: 2,
            },
            {
              cart_item_id: 'ci_2',
              part_id: 'part_2',
              title: 'Filtr',
              quantity: 1,
            },
          ],
        },
      ],
    });
    expect(routing.routeDistanceMeters).not.toHaveBeenCalled();
  });

  it('a dealer with no point on record: null, and still 200', async () => {
    prisma.cart.findUnique.mockResolvedValue({
      items: [
        {
          id: 'ci_1',
          partId: 'part_1',
          offerId: null,
          serviceId: null,
          title: 'Kolodka',
          quantity: 1,
          offer: null,
        },
      ],
    });
    prisma.catalogPart.findMany.mockResolvedValue([
      { id: 'part_1', sellerId: 'seller_1' },
    ]);
    prisma.catalogSeller.findMany.mockResolvedValue([
      { id: 'seller_1', name: 'Avto Ehtiyot', internalSellerId: 1 },
    ]);
    prisma.seller.findMany.mockResolvedValue([
      {
        id: 1,
        tgId: null,
        catalogSellerId: null,
        storeName: null,
        marketName: null,
        addressComment: null,
        locationLat: null,
        locationLng: null,
      },
    ]);

    const res = await get().expect(200);

    expect(res.body.pickup_points).toEqual([
      expect.objectContaining({
        dealer_id: 'seller_1',
        address: null,
        landmark: null,
        location: null,
      }),
    ]);
  });

  it('an empty cart answers an empty list', async () => {
    prisma.cart.findUnique.mockResolvedValue(null);

    const res = await get().expect(200);

    expect(res.body).toEqual({ pickup_points: [] });
  });
});
