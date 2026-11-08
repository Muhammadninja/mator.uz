/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- the fake client is untyped by design */
// FIN-001: on a tracked cash or terminal order, money counts when it is collected.
import { OrderStatus, PaymentType, Prisma } from '@prisma/client';
import {
  BLOCKED_ORDER,
  PAYABLE_ORDER,
  TOOK_MONEY,
} from '../admin/finance/seller-ledger';
import { readRefundPosition } from './financial-refund.ledger';
import { OfflineCollectionService } from './offline-collection.service';
import { AWAITING_OFFLINE_MONEY } from './offline-order.policy';
import { canOperatorTransition } from './order-transitions';
import { OrderStatusService } from './order-status.service';
import { OrdersService } from './orders.service';
import {
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeNotifications,
  fakeRealtime,
} from '../../test/utils/harness';

const ACTOR = { id: 'adm_1', email: 'o@x.uz', name: 'Operator' };
const TOTAL = 215000;

function world(over: Record<string, unknown> = {}) {
  const order: any = {
    status: OrderStatus.SHIPPED,
    paymentType: PaymentType.CASH,
    totalUzs: new Prisma.Decimal(TOTAL),
    serviceFeeUzs: new Prisma.Decimal(0),
    deliveryUzs: new Prisma.Decimal(0),
    items: [{ sellerId: 's1', lineTotalUzs: new Prisma.Decimal(TOTAL) }],
    offlineCollectionRequired: true,
    offlineCollection: null,
    payments: [],
    ...over,
  };
  let queue: Promise<unknown> = Promise.resolve();
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    order: { findUnique: jest.fn(async () => order) },
    offlineCollection: {
      create: jest.fn(async ({ data }: any) => {
        order.offlineCollection = data;
        return data;
      }),
    },
    payment: { findMany: jest.fn(async () => []) },
    financialRefund: { findMany: jest.fn(async () => []) },
    // Only an older order is read by its PAID history row.
    orderStatusHistory: {
      count: jest.fn(async () => (order.offlineCollectionRequired ? 0 : 1)),
    },
  };
  const prisma: any = {
    $transaction: jest.fn((work: any) => {
      const run = queue.then(() => work(tx));
      queue = run.catch(() => undefined);
      return run;
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new OfflineCollectionService(prisma, audit as never);
  const received = async () =>
    Number((await readRefundPosition(tx, 'ord_1')).received);
  return { order, tx, audit, service, received };
}
const collect = (w: ReturnType<typeof world>, over: object = {}) =>
  w.service.record('ord_1', { amountUzs: TOTAL, ...over }, ACTOR);

describe('offline collection (FIN-001)', () => {
  it('COD shipped, not collected: received is zero', async () => {
    const w = world();
    await expect(w.received()).resolves.toBe(0);
  });

  it('COD collected: the amount is received, attributed to the operator', async () => {
    const w = world();
    const res = await collect(w, { reference: 'KASSA-7' });
    await expect(w.received()).resolves.toBe(TOTAL);
    expect(res).toMatchObject({
      method: 'cash',
      amountUzs: TOTAL,
      reference: 'KASSA-7',
      collectedBy: 'Operator',
      alreadyRecorded: false,
    });
    expect(w.audit.record).toHaveBeenCalledTimes(1);
  });

  it('terminal: collected with its slip number', async () => {
    const w = world({ paymentType: PaymentType.TERMINAL });
    await expect(collect(w)).rejects.toMatchObject({
      response: { code: 'COLLECTION_REFERENCE_REQUIRED' },
    });
    const res = await collect(w, { reference: 'SLIP-1' });
    expect(res.method).toBe('terminal');
    await expect(w.received()).resolves.toBe(TOTAL);
  });

  it('cancelled after shipping with no collection: nothing was received or refundable', async () => {
    const w = world({ status: OrderStatus.CANCELLED });
    const position = await readRefundPosition(w.tx, 'ord_1');
    expect(Number(position.received)).toBe(0);
    expect(Number(position.remaining)).toBe(0);
    await expect(collect(w)).rejects.toMatchObject({
      response: { code: 'ORDER_NOT_COLLECTIBLE' },
    });
  });

  it('after a real collection the amount can be refunded under the existing rules', async () => {
    const w = world();
    await collect(w);
    w.order.status = OrderStatus.CANCELLED;
    expect(Number((await readRefundPosition(w.tx, 'ord_1')).remaining)).toBe(
      TOTAL,
    );
  });

  it('duplicate requests record it once', async () => {
    const w = world();
    const [a, b] = await Promise.all([collect(w), collect(w)]);
    expect(w.tx.offlineCollection.create).toHaveBeenCalledTimes(1);
    expect(w.audit.record).toHaveBeenCalledTimes(1);
    expect([a.alreadyRecorded, b.alreadyRecorded].sort()).toEqual([
      false,
      true,
    ]);
    await expect(w.received()).resolves.toBe(TOTAL);
  });

  it('takes the order’s row lock first', async () => {
    const w = world();
    await collect(w);
    expect(w.tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
  });

  it('refuses another amount, on a first record and on a repeat', async () => {
    const w = world();
    await expect(collect(w, { amountUzs: 1000 })).rejects.toMatchObject({
      response: { code: 'COLLECTION_AMOUNT_MISMATCH' },
    });
    await collect(w);
    await expect(collect(w, { amountUzs: 1000 })).rejects.toMatchObject({
      response: { code: 'COLLECTION_ALREADY_RECORDED' },
    });
  });

  it('refuses an online order and one awaiting confirmation', async () => {
    await expect(
      collect(world({ paymentType: PaymentType.PAYME })),
    ).rejects.toMatchObject({ response: { code: 'ORDER_NOT_OFFLINE' } });
    await expect(
      collect(world({ status: OrderStatus.PENDING_PAYMENT })),
    ).rejects.toMatchObject({ response: { code: 'ORDER_NOT_COLLECTIBLE' } });
  });

  it('refuses a status that is no part of this flow, and an order paid online', async () => {
    await expect(collect(world({ status: OrderStatus.PAID }))).rejects.toMatchObject({
      response: { code: 'ORDER_NOT_COLLECTIBLE' },
    });
    await expect(collect(world({ payments: [{ id: 'p' }] }))).rejects.toMatchObject({
      response: { code: 'ORDER_PAID_ONLINE' },
    });
  });

  for (const status of [
    OrderStatus.PROCESSING,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
  ]) {
    it(`${status}: nothing is received until the operator confirms it`, async () => {
      const w = world({ status });
      await expect(w.received()).resolves.toBe(0);
      await collect(w);
      await expect(w.received()).resolves.toBe(TOTAL);
      expect(w.order.status).toBe(status);
    });
  }

  it('claims no fiscal receipt that nobody stated', async () => {
    const w = world();
    const res = await collect(w);
    expect(res.fiscalReference).toBeNull();
  });

  it('leaves an older order on its original reading, without rewriting it', async () => {
    const w = world({ offlineCollectionRequired: false });
    await expect(w.received()).resolves.toBe(TOTAL);
    await expect(collect(w)).rejects.toMatchObject({
      response: { code: 'COLLECTION_NOT_TRACKED' },
    });
  });

  it('keeps counting an online order by its payment rows', async () => {
    const w = world({
      paymentType: PaymentType.PAYME,
      offlineCollectionRequired: false,
    });
    w.tx.payment.findMany.mockResolvedValue([
      { id: 'p', amountUzs: new Prisma.Decimal(1000), status: 'PAID' },
    ]);
    await expect(w.received()).resolves.toBe(1000);
  });

  describe('finance filters', () => {
    it('counts a tracked order only by its collection or a provider settlement', () => {
      expect(TOOK_MONEY.OR).toEqual([
        {
          offlineCollectionRequired: false,
          statusHistory: { some: { status: OrderStatus.PAID } },
        },
        { offlineCollectionRequired: true, offlineCollection: { isNot: null } },
        {
          offlineCollectionRequired: true,
          payments: { some: { status: { in: ['PAID', 'REFUNDED'] } } },
        },
      ]);
    });

    it('keeps both conditions when an order must also be blocked', () => {
      expect(BLOCKED_ORDER.AND).toHaveLength(2);
      expect(PAYABLE_ORDER.OR).toBe(TOOK_MONEY.OR);
    });
  });
});

describe('status and money are separate (FIN-001)', () => {
  const tracked = { offlineCollectionRequired: true };
  const other = { offlineCollectionRequired: false };

  it('an offline order goes to work without being marked paid', () => {
    expect(
      canOperatorTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.PROCESSING, tracked),
    ).toBe(true);
    expect(
      canOperatorTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, tracked),
    ).toBe(false);
  });

  it('keeps the path of every other order', () => {
    expect(
      canOperatorTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.PROCESSING, other),
    ).toBe(false);
    expect(
      canOperatorTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, other),
    ).toBe(true);
  });

  function orders(order: Record<string, unknown>) {
    const prisma: any = createPrismaMock();
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({ id: 'ord_1', status: OrderStatus.PENDING_PAYMENT, ...order }),
    );
    prisma.order.findUniqueOrThrow.mockResolvedValue(buildOrder({ id: 'ord_1' }));
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    return new OrdersService(
      prisma,
      fakeConfig(),
      fakeNotifications(),
      fakeRealtime(),
      new OrderStatusService(prisma),
      {} as never,
      { record: jest.fn() } as never,
      {} as never,
    );
  }

  it('refuses to mark an offline order paid, however the operator asks', async () => {
    await expect(
      orders(tracked).updateStatus('ord_1', { status: 'paid' } as never),
    ).rejects.toMatchObject({
      response: { code: 'OFFLINE_PAYMENT_NEEDS_COLLECTION' },
    });
  });

  it('moves an offline order into processing from awaiting payment', async () => {
    await expect(
      orders(tracked).updateStatus('ord_1', { status: 'processing' } as never),
    ).resolves.toBeDefined();
  });

  it('still refuses that jump on any other order', async () => {
    await expect(
      orders(other).updateStatus('ord_1', { status: 'processing' } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('an order awaiting its money is excluded by what the figures filter on', () => {
    expect(AWAITING_OFFLINE_MONEY).toMatchObject({
      offlineCollectionRequired: true,
      offlineCollection: { is: null },
    });
  });
});
