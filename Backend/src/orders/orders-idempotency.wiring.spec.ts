/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- the guard double reads an untyped execution context */
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { OfflineCollectionService } from './offline-collection.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

// POST /v1/orders through a real Nest HTTP app, with the global pipe and filter as main.ts
// installs them: the header reaches the service exactly as sent, a malformed one is a 400
// with its code before anything is placed, and a replay is told apart only by a header.
describe('POST /v1/orders Idempotency-Key (wiring)', () => {
  let app: INestApplication;
  const checkout = jest.fn();
  const body = {
    cart_snapshot: { delivery_method: 'pickup' },
    payment_type: 'cash',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: OrdersService, useValue: { checkout } },
        { provide: OfflineCollectionService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { id: 'usr_1' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
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

  afterAll(async () => await app.close());
  beforeEach(() => checkout.mockReset());

  const post = () => request(app.getHttpServer()).post('/v1/orders').send(body);

  it('passes the key to the checkout and answers 201 with the order', async () => {
    checkout.mockResolvedValue({
      order: { order_id: 'ord_1' },
      replayed: false,
    });
    const res = await post()
      .set('Idempotency-Key', 'ord_abc_123456')
      .expect(201);

    expect(res.body).toEqual({ order_id: 'ord_1' });
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(checkout).toHaveBeenCalledWith(
      'usr_1',
      expect.objectContaining({ payment_type: 'cash' }),
      'ord_abc_123456',
    );
  });

  it('answers a replay with the same status and body, marked by a header', async () => {
    checkout.mockResolvedValue({
      order: { order_id: 'ord_1' },
      replayed: true,
    });
    const res = await post()
      .set('Idempotency-Key', 'ord_abc_123456')
      .expect(201);

    expect(res.body).toEqual({ order_id: 'ord_1' });
    expect(res.headers['idempotent-replayed']).toBe('true');
  });

  it('keeps a client that sends no key working, without one', async () => {
    checkout.mockResolvedValue({
      order: { order_id: 'ord_2' },
      replayed: false,
    });
    await post().expect(201);
    expect(checkout).toHaveBeenCalledWith('usr_1', expect.anything(), null);
  });

  it.each(['short', 'not a key!', 'x'.repeat(129)])(
    'refuses the malformed key %p with 400 INVALID_IDEMPOTENCY_KEY and places nothing',
    async (key) => {
      const res = await post().set('Idempotency-Key', key).expect(400);
      expect(res.body).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
      expect(checkout).not.toHaveBeenCalled();
    },
  );

  it('refuses a key sent twice (joined by a comma), rather than picking one', async () => {
    const res = await post()
      // How Node hands a repeated header to the app.
      .set('Idempotency-Key', 'ord_one_key_1, ord_two_key_2')
      .expect(400);
    expect(res.body).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
  });
});
