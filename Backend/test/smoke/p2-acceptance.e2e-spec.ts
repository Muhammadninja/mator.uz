/* eslint-disable @typescript-eslint/no-explicit-any */
// The owner's P2 decisions end to end, over fakes: Redis, Prisma and the queue are
// doubles, so this proves the wiring and the HTTP contract, not any real server.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from '../../src/auth/auth.controller';
import { AuthService } from '../../src/auth/auth.service';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { OtpService } from '../../src/auth/phone/otp.service';
import { PhoneAuthService } from '../../src/auth/phone/phone-auth.service';
import { TokenService } from '../../src/auth/tokens/token.service';
import { CartService } from '../../src/cart/cart.service';
import { CategoriesService } from '../../src/catalog/categories/categories.service';
import { PartsService } from '../../src/catalog/parts/parts.service';
import { SearchService } from '../../src/catalog/search/search.service';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { findUnavailableParts } from '../../src/orders/order-availability';
import { FixedWindowRateLimiter } from '../../src/redis/rate-limiter.service';
import { RedisKeys } from '../../src/redis/redis.keys';
import {
  createPrismaMock,
  fakeConfig,
  fakeDiscounts,
  fakeQueue,
  fakeRedis,
} from '../utils/harness';

describe('OTP sending over HTTP', () => {
  let app: INestApplication;
  let redis: any;
  let queue: any;
  const server = () => app.getHttpServer();
  const body = (phone: string) => ({ phone_e164: phone });

  beforeAll(async () => {
    redis = fakeRedis();
    queue = fakeQueue();
    const prisma = createPrismaMock();
    prisma.appUser.findUnique.mockResolvedValue(null);
    const otp = new OtpService(
      redis,
      queue,
      fakeConfig(),
      new FixedWindowRateLimiter(redis),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: TokenService, useValue: {} },
        {
          provide: PhoneAuthService,
          useValue: new PhoneAuthService(prisma, otp, {} as any, {} as any),
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    redis.store.clear();
    redis.ttls.clear();
    queue.enqueueOtpSms.mockClear();
  });

  const elapse = () => {
    for (const key of [...redis.store.keys()]) {
      if (key.startsWith('otp:cooldown:')) redis.store.delete(key);
    }
  };

  it('accepts the first, refuses the second with Retry-After, and sends once', async () => {
    await request(server()).post('/v1/auth/phone/request-otp').send(body('+998901112233')).expect(200);
    const refused = await request(server())
      .post('/v1/auth/phone/request-otp')
      .send(body('+998901112233'))
      .expect(429);
    expect(refused.headers['retry-after']).toBe('60');
    expect(refused.body).toMatchObject({
      code: 'OTP_COOLDOWN_ACTIVE',
      details: { retry_after_seconds: 60 },
    });
    expect(refused.body.message).toContain('60s');
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(1);
  });

  it('holds a resend to the same minute, then lets it through', async () => {
    const first = await request(server())
      .post('/v1/auth/phone/request-otp')
      .send(body('+998901112244'))
      .expect(200);
    const resend = { request_id: first.body.request_id };
    await request(server()).post('/v1/auth/phone/resend-otp').send(resend).expect(429);
    elapse();
    await request(server()).post('/v1/auth/phone/resend-otp').send(resend).expect(200);
    expect(queue.enqueueOtpSms).toHaveBeenCalledTimes(2);
  });

  it('keeps different numbers apart', async () => {
    await request(server()).post('/v1/auth/phone/request-otp').send(body('+998901112255')).expect(200);
    await request(server()).post('/v1/auth/phone/request-otp').send(body('+998901112266')).expect(200);
  });

  it('answers 503 when the queue refuses, and the number can retry at once', async () => {
    queue.enqueueOtpSms.mockRejectedValueOnce(new Error('queue down'));
    const failed = await request(server())
      .post('/v1/auth/phone/request-otp')
      .send(body('+998901112277'))
      .expect(503);
    expect(failed.body.code).toBe('OTP_SEND_UNAVAILABLE');
    expect(redis.store.has(RedisKeys.otp('+998901112277'))).toBe(false);
  });

  it('carries no route-specific sending limit', () => {
    for (const handler of ['requestOtp', 'resendOtp'] as const) {
      expect(
        Reflect.getMetadata('THROTTLER:LIMITdefault', AuthController.prototype[handler]),
      ).toBeUndefined();
    }
  });
});

describe('an inactive category, across the buyer surfaces', () => {
  const edges = [
    { id: 'brakes', parentId: null, isActive: true },
    { id: 'pads', parentId: 'brakes', isActive: false },
    { id: 'front-pads', parentId: 'pads', isActive: true },
  ];
  function world() {
    const prisma = createPrismaMock();
    prisma.partCategory.findMany.mockResolvedValue(edges);
    prisma.catalogPart.findMany.mockResolvedValue([]);
    prisma.catalogPart.groupBy.mockResolvedValue([]);
    prisma.catalogPart.count.mockResolvedValue(0);
    prisma.catalogPart.aggregate.mockResolvedValue({ _min: {}, _max: {} });
    return prisma;
  }
  const hidesBoth = (where: unknown) => {
    const json = JSON.stringify(where);
    expect(json).toContain('"pads"');
    expect(json).toContain('"front-pads"');
  };

  it('listing, search, typeahead and grid all exclude it and everything beneath', async () => {
    const prisma = world();
    await new PartsService(prisma, fakeDiscounts()).list({} as any);
    hidesBoth(prisma.catalogPart.count.mock.calls[0][0].where);

    const searched = world();
    const search = new SearchService(searched, fakeDiscounts());
    await search.search({ query: 'x' });
    await search.typeahead('x');
    for (const [args] of searched.catalogPart.findMany.mock.calls) hidesBoth(args.where);

    const grid = world();
    await new CategoriesService(grid).list({ scope: 'main' } as any);
    hidesBoth(grid.catalogPart.groupBy.mock.calls[0][0].where);
  });

  it('the detail and both compatibility reads answer not found', async () => {
    const prisma = world();
    const hidden = { id: 'p', categoryId: 'front-pads', compatibilities: [], fitmentBindings: [] };
    prisma.catalogPart.findFirst.mockResolvedValue(hidden);
    prisma.catalogPart.findUnique.mockResolvedValue(hidden);
    const parts = new PartsService(prisma, fakeDiscounts());
    await expect(parts.detail('p')).rejects.toMatchObject({ status: 404 });
    await expect(parts.compatibility('p', 'v')).rejects.toMatchObject({ status: 404 });
    await expect(parts.checkCompatibility('p', {})).rejects.toMatchObject({ status: 404 });
  });

  it('a cart cannot take it, and an order or invoice refuses it', async () => {
    const prisma = world();
    prisma.cart.upsert.mockResolvedValue({ id: 'c', userId: 'u', items: [] });
    prisma.catalogPart.findFirst.mockResolvedValue({ inStock: true, stockQty: 0, categoryId: 'pads' });
    await expect(
      new CartService(prisma, fakeDiscounts()).addItem('u', { part_id: 'p' } as any),
    ).rejects.toMatchObject({ status: 404 });

    prisma.catalogPart.findMany.mockResolvedValue([
      { id: 'p', inStock: true, stockQty: 0, priceUzs: 100, categoryId: 'pads', seller: { status: 'ACTIVE' } },
    ]);
    await expect(
      findUnavailableParts(prisma, [{ partId: 'p', title: 'F', quantity: 1 }]),
    ).resolves.toEqual([{ partId: 'p', title: 'F', reason: 'category_hidden' }]);
  });
});

describe('stock at the cart', () => {
  function cart(row: any) {
    const prisma = createPrismaMock();
    prisma.partCategory.findMany.mockResolvedValue([]);
    prisma.cartItem.findUnique.mockResolvedValue({ id: 'i', partId: 'p', title: 'F', cart: { userId: 'u' } });
    prisma.catalogPart.findMany.mockResolvedValue([
      { id: 'p', priceUzs: 100, categoryId: 'c', seller: { status: 'ACTIVE' }, ...row },
    ]);
    return { prisma, service: new CartService(prisma, fakeDiscounts()) };
  }

  it('refuses a stale line once a real count reaches zero, stating 0 available', async () => {
    const { prisma, service } = cart({ inStock: false, stockQty: 0 });
    await expect(service.updateItem('u', 'i', 1)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'PART_UNAVAILABLE',
        details: { lines: [{ part_id: 'p', available_quantity: 0, requested_quantity: 1 }] },
      },
    });
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('refuses more than a real count, and allows exactly it', async () => {
    const { service } = cart({ inStock: true, stockQty: 3 });
    await expect(service.updateItem('u', 'i', 4)).rejects.toMatchObject({ status: 409 });
    const within = cart({ inStock: true, stockQty: 3 });
    within.prisma.cartItem.update.mockResolvedValue({});
    within.prisma.cart.upsert.mockResolvedValue({ id: 'c', userId: 'u', items: [] });
    await within.service.updateItem('u', 'i', 3);
    expect(within.prisma.cartItem.update).toHaveBeenCalledTimes(1);
  });

  it('leaves an uncounted Telegram listing as it was', async () => {
    const { prisma, service } = cart({ inStock: true, stockQty: 0 });
    prisma.cartItem.update.mockResolvedValue({});
    prisma.cart.upsert.mockResolvedValue({ id: 'c', userId: 'u', items: [] });
    await service.updateItem('u', 'i', 50);
    expect(prisma.cartItem.update).toHaveBeenCalledTimes(1);
  });
});
