/* eslint-disable @typescript-eslint/no-explicit-any */
// ORD-003, LOW-PAY-006, LOW-PAY-011, LOW-ORD-012 and LOW-ORD-013. Rows live in memory,
// so these say nothing about PostgreSQL's row locks or isolation.
import { ConflictException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, PaymentType } from '@prisma/client';
import {
  PART_UNAVAILABLE,
  assertAllAvailable,
  exceedsCountedStock,
  findUnavailableParts,
} from './order-availability';
import { CartService } from '../cart/cart.service';
import { OrderStatusService } from './order-status.service';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments.service';
import { SettlementService } from './webhooks/settlement.service';
import { PaymeTransactionSweeper } from './webhooks/payme-transaction.sweeper';
import { PaymeService, PAYME_TRANSACTION_TIMEOUT_MS } from './webhooks/payme.service';
import { settlementStore } from './webhooks/settlement-store.test-util';
import {
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeDiscounts,
  fakeFiscal,
} from '../../test/utils/harness';

const part = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  inStock: true,
  stockQty: 2,
  priceUzs: 1000,
  seller: { status: 'ACTIVE' },
  ...over,
});

describe('quantity against counted stock (ORD-003)', () => {
  const check = async (row: Record<string, unknown>, quantity: number) => {
    const prisma = createPrismaMock();
    prisma.catalogPart.findMany.mockResolvedValue([row]);
    return findUnavailableParts(prisma, [{ partId: 'p1', title: 'Filter', quantity }]);
  };

  it('2 on hand: 3 is refused, with what is available', async () => {
    await expect(check(part(), 3)).resolves.toEqual([
      {
        partId: 'p1',
        title: 'Filter',
        reason: 'insufficient_stock',
        availableQuantity: 2,
        requestedQuantity: 3,
      },
    ]);
  });

  it('exactly what is on hand is fine', async () => {
    await expect(check(part(), 2)).resolves.toEqual([]);
  });

  it('a counted position that ran out is refused', async () => {
    const [line] = await check(part({ inStock: false, stockQty: 0 }), 1);
    expect(line.reason).toBe('out_of_stock');
  });

  it('a Telegram listing, not counted, keeps its behaviour', async () => {
    await expect(check(part({ stockQty: 0 }), 999)).resolves.toEqual([]);
  });

  it('two lines of one position draw on one count', async () => {
    const prisma = createPrismaMock();
    prisma.catalogPart.findMany.mockResolvedValue([part()]);
    const lines = await findUnavailableParts(prisma, [
      { partId: 'p1', title: 'Filter', quantity: 2 },
      { partId: 'p1', title: 'Filter', quantity: 1 },
    ]);
    expect(lines).toHaveLength(2);
  });

  it('a caller naming no quantity keeps the previous availability answer', async () => {
    const prisma = createPrismaMock();
    prisma.catalogPart.findMany.mockResolvedValue([part({ stockQty: 1 })]);
    await expect(
      findUnavailableParts(prisma, [{ partId: 'p1', title: 'F' }]),
    ).resolves.toEqual([]);
  });

  it('the refusal is a 409 carrying the quantities', () => {
    let thrown: ConflictException | undefined;
    try {
      assertAllAvailable([
        { partId: 'p1', title: 'F', reason: 'insufficient_stock', availableQuantity: 2, requestedQuantity: 3 },
      ]);
    } catch (err) {
      thrown = err as ConflictException;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(thrown!.getResponse()).toMatchObject({
      code: PART_UNAVAILABLE,
      details: { lines: [{ part_id: 'p1', available_quantity: 2, requested_quantity: 3 }] },
    });
  });

  it('a real zero is refused as out of stock, with 0 available', async () => {
    const prisma = createPrismaMock();
    prisma.catalogPart.findMany.mockResolvedValue([part({ stockQty: 0, inStock: false })]);
    const lines = await findUnavailableParts(prisma, [{ partId: 'p1', title: 'Filter', quantity: 1 }]);
    expect(lines).toEqual([
      expect.objectContaining({ reason: 'out_of_stock', availableQuantity: 0, requestedQuantity: 1 }),
    ]);
    expect.assertions(2);
    try {
      assertAllAvailable(lines);
    } catch (err) {
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: PART_UNAVAILABLE,
        details: { lines: [{ part_id: 'p1', available_quantity: 0, requested_quantity: 1 }] },
      });
    }
  });

  it('zero means not counted', () => {
    expect(exceedsCountedStock(0, 999)).toBe(false);
    expect(exceedsCountedStock(5, 6)).toBe(true);
  });

  describe('the cart', () => {
    function cart(items: any[], row: any) {
      const prisma = createPrismaMock();
      prisma.cart.upsert.mockResolvedValue({ id: 'c1', userId: 'u1', items });
      prisma.catalogPart.findFirst.mockResolvedValue({ title: 'Filter', images: [], ...row });
      return { prisma, service: new CartService(prisma, fakeDiscounts()) };
    }

    it('refuses adding more than is on hand', async () => {
      const { prisma, service } = cart([], part());
      await expect(service.addItem('u1', { part_id: 'p1', quantity: 3 } as any)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.cartItem.create).not.toHaveBeenCalled();
    });

    it('counts what the line already holds', async () => {
      const { prisma, service } = cart([{ id: 'i1', partId: 'p1', quantity: 2 }], part());
      await expect(service.addItem('u1', { part_id: 'p1', quantity: 1 } as any)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.cartItem.update).not.toHaveBeenCalled();
    });

    it('refuses raising a line past what is on hand', async () => {
      const { prisma, service } = cart([], part());
      prisma.cartItem.findUnique.mockResolvedValue({
        id: 'i1', partId: 'p1', title: 'Filter', cart: { userId: 'u1' },
      });
      prisma.catalogPart.findUnique.mockResolvedValue({ stockQty: 2 });
      await expect(service.updateItem('u1', 'i1', 3)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.cartItem.update).not.toHaveBeenCalled();
    });
  });

  it('invoice creation counts quantities too', async () => {
    const prisma = createPrismaMock();
    prisma.order.findUnique.mockResolvedValue(buildOrder({ id: 'o1', userId: 'u1', status: 'PENDING_PAYMENT' }));
    prisma.orderItem.findMany.mockResolvedValue([{ partId: 'p1', title: 'F', quantity: 3 }]);
    prisma.catalogPart.findMany.mockResolvedValue([part()]);
    const service = new PaymentsService(prisma, fakeConfig({ PAYME_MERCHANT_ID: 'm', PAYME_MERCHANT_KEY: 'k' }), fakeFiscal(prisma));
    await expect(service.createPaymeInvoice('u1', { order_id: 'o1' } as any)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});

function settlement(store: ReturnType<typeof settlementStore>) {
  return new SettlementService(
    store.prisma as any,
    { emit: jest.fn().mockResolvedValue(undefined) } as any,
    { emit: jest.fn() } as any,
    new OrderStatusService(store.prisma as any),
    fakeConfig({ ORDER_TTL_MIN: '30' }),
  );
}

const order = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  userId: 'usr_1',
  status: OrderStatus.PENDING_PAYMENT,
  expiresAt: new Date('2026-01-01'),
  totalUzs: 1000,
  paymentType: PaymentType.PAYME,
  ...over,
});
const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay_1',
  orderId: 'ord_1',
  status: PaymentStatus.PENDING,
  provider: 'PAYME',
  providerState: 1,
  providerTransactionId: 'tx_1',
  providerCreateTime: BigInt(1),
  amountUzs: 1000,
  ...over,
});

describe('stale Payme transactions (LOW-PAY-006)', () => {
  const NOW = 1_800_000_000_000;

  function sweeper(store: ReturnType<typeof settlementStore>, stale: string[]) {
    const prisma = { payment: { findMany: jest.fn(async () => stale.map((id) => ({ id }))) } };
    return { prisma, sweep: new PaymeTransactionSweeper(prisma as any, settlement(store)) };
  }

  it('asks only for created transactions past 12 hours', async () => {
    const store = settlementStore({ payments: [], orders: [] });
    const { prisma, sweep } = sweeper(store, []);
    await sweep.sweep(NOW);
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: PaymentStatus.PENDING,
          providerState: 1,
          providerCreateTime: { gt: 0, lt: BigInt(NOW - PAYME_TRANSACTION_TIMEOUT_MS) },
        }),
        take: 100,
      }),
    );
  });

  it('cancels with reason 4, leaves the order payable, and records no money', async () => {
    const store = settlementStore({ payments: [payment()], orders: [order()] });
    const { sweep } = sweeper(store, ['pay_1']);
    await expect(sweep.sweep(NOW)).resolves.toBe(1);
    expect(store.payment('pay_1')).toMatchObject({
      status: PaymentStatus.CANCELLED,
      providerState: -1,
      cancelReason: 4,
    });
    expect(store.order('ord_1').status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(store.refunds()).toHaveLength(0);
  });

  it('a repeat sweep changes nothing', async () => {
    const store = settlementStore({ payments: [payment()], orders: [order()] });
    const { sweep } = sweeper(store, ['pay_1']);
    await sweep.sweep(NOW);
    const after = { ...store.payment('pay_1') };
    await expect(sweep.sweep(NOW)).resolves.toBe(0);
    expect(store.payment('pay_1')).toEqual(after);
  });

  it('a Perform that lands first wins: paid stays paid', async () => {
    const store = settlementStore({ payments: [payment()], orders: [order()] });
    const svc = settlement(store);
    const sweep = new PaymeTransactionSweeper(
      { payment: { findMany: jest.fn(async () => [{ id: 'pay_1' }]) } } as any,
      svc,
    );
    await Promise.all([svc.markPaid('pay_1', NOW), sweep.sweep(NOW)]);
    expect(store.payment('pay_1').status).toBe(PaymentStatus.PAID);
    expect(store.order('ord_1').status).toBe(OrderStatus.PAID);
  });

  it('one failure does not stop the rest', async () => {
    const markCancelled = jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('cancelled');
    const sweep = new PaymeTransactionSweeper(
      { payment: { findMany: jest.fn(async () => [{ id: 'a' }, { id: 'b' }]) } } as any,
      { markCancelled } as any,
    );
    jest.spyOn((sweep as any).logger, 'error').mockImplementation();
    await expect(sweep.sweep(NOW)).resolves.toBe(1);
  });
});

describe('provider refunds (LOW-PAY-011)', () => {
  const paidOrder = () => order({ status: OrderStatus.PAID });
  const paidPayment = () => payment({ status: PaymentStatus.PAID, providerState: 2 });

  it('takes the order lock before claiming the payment', async () => {
    const store = settlementStore({ payments: [paidPayment()], orders: [paidOrder()] });
    const order_: string[] = [];
    (store.prisma as any).$queryRaw.mockImplementation(async () => order_.push('lock'));
    const update = (store.prisma as any).payment.updateMany;
    (store.prisma as any).payment.updateMany = async (a: any) => {
      order_.push('claim');
      return update(a);
    };
    await expect(settlement(store).markCancelled('pay_1', 5, true)).resolves.toBe('refunded');
    expect(order_.slice(0, 2)).toEqual(['lock', 'claim']);
  });

  it('a repeated callback records the money once', async () => {
    const store = settlementStore({ payments: [paidPayment()], orders: [paidOrder()] });
    const svc = settlement(store);
    await Promise.all([svc.markCancelled('pay_1', 5, true), svc.markCancelled('pay_1', 5, true)]);
    await svc.markCancelled('pay_1', 5, true);
    expect(store.refunds().filter((r: any) => !r.voidedAt)).toHaveLength(
      store.refunds().length,
    );
    expect(store.history().filter((h) => h.status === OrderStatus.REFUNDED)).toHaveLength(1);
  });

  it('cancelling an unperformed payment takes no lock', async () => {
    const store = settlementStore({ payments: [payment()], orders: [order()] });
    await settlement(store).markCancelled('pay_1', 4, false);
    expect((store.prisma as any).$queryRaw).not.toHaveBeenCalled();
  });
});

describe('offline orders and online payment (LOW-ORD-013)', () => {
  describe.each([PaymentType.CASH, PaymentType.TERMINAL])('%s', (paymentType) => {
    it('cannot create a Payme or Click invoice', async () => {
      const prisma = createPrismaMock();
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'o1', userId: 'u1', status: 'PENDING_PAYMENT', paymentType }),
      );
      const service = new PaymentsService(prisma, fakeConfig({ PAYME_MERCHANT_ID: 'm', PAYMENT_PROVIDERS: 'payme,click', CLICK_SECRET_KEY: 's' }), fakeFiscal(prisma));
      for (const call of [
        () => service.createPaymeInvoice('u1', { order_id: 'o1' } as any),
        () => service.createClickInvoice('u1', { order_id: 'o1' } as any),
      ]) {
        await expect(call()).rejects.toMatchObject({
          response: { code: 'OFFLINE_ORDER_NOT_PAYABLE_ONLINE' },
        });
      }
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('a stale Payme transaction cannot settle it', async () => {
      const store = settlementStore({ payments: [payment()], orders: [order({ paymentType })] });
      await expect(settlement(store).markPaid('pay_1', 1)).resolves.toBe('order_not_payable');
      expect(store.payment('pay_1').status).toBe(PaymentStatus.PENDING);
      expect(store.order('ord_1').status).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it('Payme Check and Create refuse it', () => {
      const service = Object.create(PaymeService.prototype);
      expect(() => service.assertPayableOnline({ paymentType })).toThrow('Order is not paid online');
    });
  });

  it('a PAYME order settles as before', async () => {
    const store = settlementStore({ payments: [payment()], orders: [order()] });
    await expect(settlement(store).markPaid('pay_1', 1)).resolves.toBe('paid');
  });

  it('an order with no recorded method still pays online', () => {
    const service = Object.create(PaymeService.prototype);
    expect(() => service.assertPayableOnline({ paymentType: null })).not.toThrow();
  });
});

describe('cancelling an uncollected offline order (LOW-ORD-012)', () => {
  function statusService(count: number) {
    const tx = {
      $queryRaw: jest.fn(async () => []),
      order: { updateMany: jest.fn(async () => ({ count })) },
      orderStatusHistory: { create: jest.fn(async () => ({})) },
    };
    return { tx, service: new OrderStatusService({} as any) };
  }

  it('moves only an order with no money against it, under the row lock', async () => {
    const { tx, service } = statusService(1);
    await expect(
      service.cancelUncollectedOffline(tx as any, 'o1', { customerId: 'u1', note: 'x' }),
    ).resolves.toBe(true);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const { where } = (tx.order.updateMany.mock.calls[0] as any[])[0];
    expect(where).toMatchObject({
      status: OrderStatus.PENDING_PAYMENT,
      paymentType: { in: [PaymentType.CASH, PaymentType.TERMINAL] },
      offlineCollection: { is: null },
    });
    expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: OrderStatus.CANCELLED, actorType: 'CUSTOMER', actorId: 'u1' }),
    });
  });

  it('writes no history when nothing moved', async () => {
    const { tx, service } = statusService(0);
    await expect(service.cancelUncollectedOffline(tx as any, 'o1', { note: 'x' })).resolves.toBe(false);
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  describe('the buyer endpoint', () => {
    function build(status: OrderStatus, cancelled: boolean, userId = 'u1') {
      const prisma = {
        order: {
          findUnique: jest.fn(async () => ({ userId, status })),
          findUniqueOrThrow: jest.fn(async () => buildOrder({ id: 'o1', status: OrderStatus.CANCELLED, items: [] })),
        },
        $transaction: jest.fn(async (fn: any) => fn({})),
      };
      const orderStatus = { cancelUncollectedOffline: jest.fn(async () => cancelled) };
      const service = Object.create(OrdersService.prototype);
      Object.assign(service, { prisma, orderStatus, logger: { log: jest.fn() } });
      return { service, orderStatus };
    }

    it('cancels an eligible order', async () => {
      const { service, orderStatus } = build(OrderStatus.PENDING_PAYMENT, true);
      await service.cancelOwnOfflineOrder('u1', 'o1');
      expect(orderStatus.cancelUncollectedOffline).toHaveBeenCalledTimes(1);
    });

    it('repeating it is harmless', async () => {
      const { service, orderStatus } = build(OrderStatus.CANCELLED, false);
      await expect(service.cancelOwnOfflineOrder('u1', 'o1')).resolves.toBeDefined();
      expect(orderStatus.cancelUncollectedOffline).not.toHaveBeenCalled();
    });

    it.each([OrderStatus.PROCESSING, OrderStatus.SHIPPED, OrderStatus.DELIVERED])(
      'a %s order is refused',
      async (status) => {
        const { service } = build(status, false);
        await expect(service.cancelOwnOfflineOrder('u1', 'o1')).rejects.toMatchObject({
          response: { code: 'ORDER_NOT_CANCELLABLE' },
        });
      },
    );

    it('a collected order is refused', async () => {
      const { service } = build(OrderStatus.PENDING_PAYMENT, false);
      await expect(service.cancelOwnOfflineOrder('u1', 'o1')).rejects.toMatchObject({
        response: { code: 'ORDER_NOT_CANCELLABLE' },
      });
    });

    it('someone else’s order is not found', async () => {
      const { service, orderStatus } = build(OrderStatus.PENDING_PAYMENT, true, 'other');
      await expect(service.cancelOwnOfflineOrder('u1', 'o1')).rejects.toMatchObject({ status: 404 });
      expect(orderStatus.cancelUncollectedOffline).not.toHaveBeenCalled();
    });
  });
});
