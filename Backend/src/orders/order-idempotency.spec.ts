/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- the Prisma harness is untyped by design */
// Checkout idempotency over the REAL OrdersService. The Prisma double here has the two
// properties PostgreSQL gives this flow, so that what is asserted is what production does:
//   • transactions run one at a time (the cart's FOR UPDATE serializes checkouts of a cart),
//     each on its own copy of the data that becomes visible only when it commits, and is
//     thrown away when it fails (atomicity, read committed);
//   • (user_id, idempotency_key) is unique, so a second insert fails with P2002.
// That PostgreSQL itself behaves so is checked by test/integration/order-idempotency.int-spec.ts.
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrderStatusService } from './order-status.service';
import { OrdersService } from './orders.service';
import { DiscountService } from '../sales/discount.service';
import {
  ORDER_IDEMPOTENCY_REPLAY_MS,
  canonicalJson,
  checkoutPayloadHash,
  parseIdempotencyKey,
} from './order-idempotency';
import {
  buildCart,
  buildCartItem,
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeDeliveryQuotes,
  fakeNotifications,
  fakeRealtime,
} from '../../test/utils/harness';

const USER = 'usr_1';
const OTHER = 'usr_2';
const KEY = 'ord_m1x2y3_abcdef1234';
const PICKUP = {
  cart_snapshot: { delivery_method: 'pickup' },
  payment_type: 'cash',
} as never;
const PICKUP_TERMINAL = {
  cart_snapshot: { delivery_method: 'pickup' },
  payment_type: 'terminal',
} as never;

interface Db {
  carts: Record<string, any[]>; // userId -> lines
  orders: any[];
  keys: any[];
}

const clone = (db: Db): Db => ({
  carts: Object.fromEntries(
    Object.entries(db.carts).map(([u, l]) => [u, l.map((i) => ({ ...i }))]),
  ),
  orders: [...db.orders],
  keys: db.keys.map((k) => ({ ...k })),
});

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

/** Wire one Prisma double to a view of the data: the committed one, or a transaction's. */
function bind(client: any, view: () => Db) {
  const cartOf = (userId: string) =>
    buildCart({
      id: `cart_${userId}`,
      userId,
      items: (view().carts[userId] ?? []).map((i) => ({ ...i })),
    });
  client.cart.findUnique.mockImplementation(async ({ where }: any) =>
    cartOf(where.userId ?? String(where.id).replace(/^cart_/, '')),
  );
  client.cart.update.mockResolvedValue({});
  client.$queryRaw.mockResolvedValue([]);
  client.cartItem.updateMany.mockResolvedValue({ count: 1 });
  client.cartItem.deleteMany.mockImplementation(async ({ where }: any) => {
    const userId = String(where.cartId).replace(/^cart_/, '');
    const lines = view().carts[userId] ?? [];
    const kept = lines.filter((i) => !where.id.in.includes(i.id));
    view().carts[userId] = kept;
    return { count: lines.length - kept.length };
  });
  client.catalogPart.findMany.mockImplementation(async ({ where }: any) =>
    where.id.in.map((id: string) => ({
      id,
      inStock: true,
      priceUzs: 185000,
      seller: { status: 'ACTIVE' },
      categoryId: 'cat_1',
      sellerId: 'seller_1',
    })),
  );
  client.sale.findMany.mockResolvedValue([]);
  client.seller.findMany.mockResolvedValue([]);
  client.appUser.findUnique.mockResolvedValue(null);
  client.order.create.mockImplementation(async ({ data }: any) => {
    const order = buildOrder({ id: data.id, userId: data.userId });
    view().orders.push(order);
    return order;
  });
  client.order.findFirst.mockImplementation(
    async ({ where }: any) =>
      view().orders.find(
        (o) => o.id === where.id && o.userId === where.userId,
      ) ?? null,
  );
  client.orderIdempotency.create.mockImplementation(async ({ data }: any) => {
    const taken = view().keys.some(
      (k) =>
        k.userId === data.userId && k.idempotencyKey === data.idempotencyKey,
    );
    if (taken) throw uniqueViolation();
    view().keys.push({ ...data, createdAt: new Date() });
    return data;
  });
  client.orderIdempotency.findUnique.mockImplementation(
    async ({ where }: any) =>
      view().keys.find(
        (k) =>
          k.userId === where.userId_idempotencyKey.userId &&
          k.idempotencyKey === where.userId_idempotencyKey.idempotencyKey,
      ) ?? null,
  );
}

function world() {
  const lines = () => [
    buildCartItem({ id: `line_${Math.random()}`, cartId: `cart_${USER}` }),
  ];
  let committed: Db = { carts: { [USER]: lines() }, orders: [], keys: [] };
  const prisma: any = createPrismaMock();
  const tx: any = createPrismaMock();
  let draft: Db | null = null;
  bind(prisma, () => committed);
  bind(tx, () => draft!);
  let queue: Promise<unknown> = Promise.resolve();
  prisma.$transaction.mockImplementation((work: any) => {
    const run = queue.then(async () => {
      draft = clone(committed);
      try {
        const out = await work(tx);
        committed = draft;
        return out;
      } finally {
        draft = null; // a failed transaction leaves nothing behind
      }
    });
    queue = run.catch(() => undefined);
    return run;
  });
  const failOnce = (delegate: any, method: string, err: Error) =>
    delegate[method].mockImplementationOnce(async () => {
      throw err;
    });
  const orders = new OrdersService(
    prisma,
    fakeConfig(),
    fakeNotifications(),
    fakeRealtime(),
    new OrderStatusService(prisma),
    new DiscountService(prisma),
    { record: jest.fn() } as never,
    fakeDeliveryQuotes(),
  );
  return {
    prisma,
    tx,
    orders,
    failOnce,
    db: () => committed,
    refill: (userId = USER) => {
      committed.carts[userId] = [
        buildCartItem({
          id: `line_${Math.random()}`,
          cartId: `cart_${userId}`,
        }),
      ];
    },
    seedKey: (over: Partial<any>) => {
      const order = buildOrder({
        id: over.orderId ?? 'ord_seeded',
        userId: over.userId ?? USER,
      });
      committed.orders.push(order);
      committed.keys.push({
        userId: USER,
        idempotencyKey: KEY,
        payloadHash: checkoutPayloadHash(PICKUP),
        orderId: order.id,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + ORDER_IDEMPOTENCY_REPLAY_MS),
        ...over,
      });
      return order;
    },
  };
}

const responseOf = (err: unknown) =>
  (err as ConflictException).getResponse() as any;

describe('checkout idempotency', () => {
  it('1. a first checkout with a key creates one order and registers the key in its transaction', async () => {
    const w = world();
    const { order, replayed } = await w.orders.checkout(USER, PICKUP, KEY);

    expect(replayed).toBe(false);
    expect(w.db().orders).toHaveLength(1);
    expect(w.db().keys).toEqual([
      expect.objectContaining({
        userId: USER,
        idempotencyKey: KEY,
        payloadHash: checkoutPayloadHash(PICKUP),
        orderId: order.order_id,
      }),
    ]);
    // Written through the transaction, never beside it.
    expect(w.tx.orderIdempotency.create).toHaveBeenCalledTimes(1);
    expect(w.prisma.orderIdempotency.create).not.toHaveBeenCalled();
    const { expiresAt } = w.db().keys[0];
    expect(expiresAt.getTime()).toBeGreaterThan(
      Date.now() + ORDER_IDEMPOTENCY_REPLAY_MS - 60_000,
    );
  });

  it('2. the same key and request again returns the same order and creates none', async () => {
    const w = world();
    const first = await w.orders.checkout(USER, PICKUP, KEY);
    const again = await w.orders.checkout(USER, PICKUP, KEY);

    expect(again.replayed).toBe(true);
    expect(again.order.order_id).toBe(first.order.order_id);
    expect(w.db().orders).toHaveLength(1);
    expect(w.tx.order.create).toHaveBeenCalledTimes(1);
  });

  it('3. a retry after the cart was emptied — and after it was filled again — returns the same order', async () => {
    const w = world();
    const first = await w.orders.checkout(USER, PICKUP, KEY);
    expect(w.db().carts[USER]).toHaveLength(0);

    const emptied = await w.orders.checkout(USER, PICKUP, KEY);
    w.refill();
    const refilled = await w.orders.checkout(USER, PICKUP, KEY);

    expect(emptied.order.order_id).toBe(first.order.order_id);
    expect(refilled.order.order_id).toBe(first.order.order_id);
    expect(w.db().orders).toHaveLength(1);
    // The new cart is untouched: the retry did not consume it.
    expect(w.db().carts[USER]).toHaveLength(1);
  });

  it('4. the same key with a different request is a 409 and places nothing', async () => {
    const w = world();
    const first = await w.orders.checkout(USER, PICKUP, KEY);
    w.refill();

    const err = await w.orders
      .checkout(USER, PICKUP_TERMINAL, KEY)
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(responseOf(err)).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      details: { order_id: first.order.order_id },
    });
    expect(w.db().orders).toHaveLength(1);
    expect(w.db().carts[USER]).toHaveLength(1);
  });

  it('5. ten simultaneous requests with one key: one order, the same id in every answer', async () => {
    const w = world();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => w.orders.checkout(USER, PICKUP, KEY)),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = new Set(
      results.map(
        (r) => (r as PromiseFulfilledResult<any>).value.order.order_id,
      ),
    );
    expect(ids.size).toBe(1);
    expect(w.db().orders).toHaveLength(1);
    expect(w.db().keys).toHaveLength(1);
    expect(
      results.filter((r) => !(r as PromiseFulfilledResult<any>).value.replayed),
    ).toHaveLength(1);
  });

  it('6. a lost answer: the order committed, the retry with the same key gets that order', async () => {
    const w = world();
    // The response to this call never reaches the client.
    await w.orders.checkout(USER, PICKUP, KEY);
    const placed = w.db().orders[0].id;

    const retry = await w.orders.checkout(USER, PICKUP, KEY);
    expect(retry).toMatchObject({
      replayed: true,
      order: { order_id: placed },
    });
  });

  it('6b. a retry that missed the winner (its look-up ran first) is stopped by the unique index and rolled back', async () => {
    const w = world();
    // The winner commits while this attempt is between its look-up and its insert: the
    // look-up saw nothing, and the cart it reads is identical, so only the index stops it.
    w.seedKey({ orderId: 'ord_winner' });
    w.prisma.orderIdempotency.findUnique.mockResolvedValueOnce(null);

    const out = await w.orders.checkout(USER, PICKUP, KEY);

    expect(out).toMatchObject({
      replayed: true,
      order: { order_id: 'ord_winner' },
    });
    expect(w.tx.order.create).toHaveBeenCalledTimes(1); // it got that far…
    expect(w.db().orders.map((o) => o.id)).toEqual(['ord_winner']); // …and was undone
    expect(w.db().carts[USER]).toHaveLength(1);
    expect(w.db().keys).toHaveLength(1);
  });

  it('7. a failure inside the transaction leaves neither an order nor a key, and the retry places it', async () => {
    const w = world();
    w.failOnce(w.tx.cart, 'update', new Error('connection reset'));

    await expect(w.orders.checkout(USER, PICKUP, KEY)).rejects.toThrow(
      'connection reset',
    );
    expect(w.db().orders).toHaveLength(0);
    expect(w.db().keys).toHaveLength(0);
    expect(w.db().carts[USER]).toHaveLength(1);

    const retry = await w.orders.checkout(USER, PICKUP, KEY);
    expect(retry.replayed).toBe(false);
    expect(w.db().orders).toHaveLength(1);
    expect(w.db().keys).toHaveLength(1);
  });

  it('7b. a failing key insert (not a duplicate) rolls the order back and is reported', async () => {
    const w = world();
    w.failOnce(w.tx.orderIdempotency, 'create', new Error('disk full'));

    await expect(w.orders.checkout(USER, PICKUP, KEY)).rejects.toThrow(
      'disk full',
    );
    expect(w.db().orders).toHaveLength(0);
    expect(w.db().carts[USER]).toHaveLength(1);
  });

  it('8. two different keys are two checkouts', async () => {
    const w = world();
    const a = await w.orders.checkout(USER, PICKUP, KEY);
    w.refill();
    const b = await w.orders.checkout(USER, PICKUP, 'ord_second_key_99');

    expect(b.replayed).toBe(false);
    expect(b.order.order_id).not.toBe(a.order.order_id);
    expect(w.db().orders).toHaveLength(2);
    expect(w.db().keys).toHaveLength(2);
  });

  it('9. another buyer with the same key is a separate checkout and never sees the first order', async () => {
    const w = world();
    const mine = await w.orders.checkout(USER, PICKUP, KEY);
    w.refill(OTHER);
    const theirs = await w.orders.checkout(OTHER, PICKUP, KEY);

    expect(theirs.replayed).toBe(false);
    expect(theirs.order.order_id).not.toBe(mine.order.order_id);
    expect(
      w
        .db()
        .keys.map((k) => k.userId)
        .sort(),
    ).toEqual([USER, OTHER]);
  });

  it('10. an expired key is refused, never reused for a second order', async () => {
    const w = world();
    w.seedKey({ orderId: 'ord_old', expiresAt: new Date(Date.now() - 1000) });

    const err = await w.orders.checkout(USER, PICKUP, KEY).catch((e) => e);

    expect(responseOf(err)).toMatchObject({
      code: 'IDEMPOTENCY_KEY_EXPIRED',
      details: { order_id: 'ord_old' },
    });
    expect(w.tx.order.create).not.toHaveBeenCalled();
    expect(w.db().orders.map((o) => o.id)).toEqual(['ord_old']);
    // Retention: the row stays while its order exists; nothing in the flow deletes it.
    expect(w.db().keys).toHaveLength(1);
    expect(w.prisma.orderIdempotency.delete).not.toHaveBeenCalled();
    expect(w.prisma.orderIdempotency.deleteMany).not.toHaveBeenCalled();
  });

  it('a client that sends no key keeps the behaviour it always had', async () => {
    const w = world();
    const { replayed } = await w.orders.checkout(USER, PICKUP, null);
    expect(replayed).toBe(false);
    expect(w.db().orders).toHaveLength(1);
    expect(w.db().keys).toHaveLength(0);
    expect(w.prisma.orderIdempotency.findUnique).not.toHaveBeenCalled();

    const err = await w.orders.checkout(USER, PICKUP, null).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException); // Cart is empty, as before
  });

  it('a business refusal with a new key registers nothing, so the corrected request can use it', async () => {
    const w = world();
    w.db().carts[USER] = [];
    await expect(w.orders.checkout(USER, PICKUP, KEY)).rejects.toThrow(
      'Cart is empty',
    );
    expect(w.db().keys).toHaveLength(0);

    w.refill();
    const placed = await w.orders.checkout(USER, PICKUP_TERMINAL, KEY);
    expect(placed.replayed).toBe(false);
    expect(w.db().orders).toHaveLength(1);
  });
});

describe('parseIdempotencyKey', () => {
  it.each([
    'ord_m1x2y3_abcdef1234',
    '3f1c2b9e-1d2a-4c5b-9e8f-0a1b2c3d4e5f',
    'a'.repeat(128),
  ])('accepts %s', (key) => expect(parseIdempotencyKey(key)).toBe(key));

  it('treats an absent header as no key', () =>
    expect(parseIdempotencyKey(undefined)).toBeNull());

  it.each([
    '',
    'short',
    'a'.repeat(129),
    'has space here',
    'ключ_заказа_123',
    'a,b-duplicate-header',
    ['ord_one_key_1', 'ord_two_key_2'],
  ])('refuses %p with INVALID_IDEMPOTENCY_KEY', (raw) => {
    try {
      parseIdempotencyKey(raw);
      throw new Error('accepted');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'INVALID_IDEMPOTENCY_KEY',
      });
    }
  });
});

describe('checkoutPayloadHash', () => {
  it('does not depend on the order of keys', () => {
    const a = {
      payment_type: 'cash',
      cart_snapshot: { promo_code: null, delivery_method: 'pickup' },
    };
    const b = {
      cart_snapshot: { delivery_method: 'pickup', promo_code: null },
      payment_type: 'cash',
    };
    expect(checkoutPayloadHash(a)).toBe(checkoutPayloadHash(b));
  });

  it('ignores absent fields but not null or changed ones', () => {
    const base = { payment_type: 'cash', vehicle_id: undefined };
    expect(checkoutPayloadHash(base)).toBe(
      checkoutPayloadHash({ payment_type: 'cash' }),
    );
    expect(checkoutPayloadHash(base)).not.toBe(
      checkoutPayloadHash({ payment_type: 'cash', vehicle_id: null }),
    );
    expect(checkoutPayloadHash(base)).not.toBe(
      checkoutPayloadHash({ payment_type: 'terminal' }),
    );
    expect(checkoutPayloadHash({ confirmed_total_uzs: 215000 })).not.toBe(
      checkoutPayloadHash({ confirmed_total_uzs: 215001 }),
    );
  });

  it('is a SHA-256 hex digest of canonical JSON', () => {
    expect(checkoutPayloadHash({})).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: 'x' })).toBe(
      '{"a":"x","b":[{"c":2,"d":1}]}',
    );
  });
});
