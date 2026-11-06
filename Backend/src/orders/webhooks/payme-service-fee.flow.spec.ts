/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- the in-memory store and the JSON-RPC replies are untyped by design, like the other settlement-store specs */
/**
 * An order with a service fee, paid through Payme and given back: the real PaymeService and
 * SettlementService over the in-memory store, which serialises transactions and re-checks a
 * conditional write against the current row. It proves the logic, not PostgreSQL.
 *
 * Check and Create, where the receipt and the amount are agreed, are in
 * test/smoke/payme-fiscal.e2e-spec.ts. This is what follows: Perform, its repeats, and a
 * Cancel that refunds the whole of it, fee included.
 */
import { OrderStatus } from '@prisma/client';
import { readRefundPosition } from '../financial-refund.ledger';
import { OrderStatusService } from '../order-status.service';
import { fakeConfig } from '../../../test/utils/harness';
import { PaymeService } from './payme.service';
import { SettlementService } from './settlement.service';
import {
  order,
  pendingPaymePayment,
  settlementStore,
} from './settlement-store.test-util';

const KEY = 'merchant-secret';
const AUTH = 'Basic ' + Buffer.from(`Paycom:${KEY}`).toString('base64');
const CONFIG = fakeConfig({
  PAYME_MERCHANT_KEY: KEY,
  PAYME_MERCHANT_ID: 'merchant-1',
  PAYME_ACCOUNT_FIELD: 'order_id',
});

/** The brief's example: 600 000 of parts, a 20 000 fee and 25 000 of delivery. */
const ORDER = {
  subtotalUzs: 600_000,
  discountUzs: 0,
  serviceFeeUzs: 20_000,
  deliveryUzs: 25_000,
  totalUzs: 645_000,
};

function build(status: OrderStatus = OrderStatus.PENDING_PAYMENT) {
  const store = settlementStore({
    payments: [
      pendingPaymePayment({
        amountUzs: ORDER.totalUzs,
        amountTiyin: BigInt(ORDER.totalUzs * 100),
        providerCancelTime: null,
        cancelReason: null,
      }),
    ],
    orders: [order(status, ORDER)],
  });
  const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
  const settlement = new SettlementService(
    store.prisma as any,
    notifications as any,
    { emit: jest.fn() } as any,
    new OrderStatusService(store.prisma as any),
    CONFIG,
  );
  const payme = new PaymeService(
    store.prisma as any,
    CONFIG,
    settlement,
    {} as any,
  );
  const rpc = (method: string, params: Record<string, unknown>) =>
    payme.handle(AUTH, { id: 1, method, params }) as Promise<any>;
  return {
    store,
    notifications,
    perform: () => rpc('PerformTransaction', { id: 'pmt-xyz' }),
    cancel: (reason = 5) => rpc('CancelTransaction', { id: 'pmt-xyz', reason }),
    check: () => rpc('CheckTransaction', { id: 'pmt-xyz' }),
    position: () => readRefundPosition(store.prisma as any, 'ord_1'),
  };
}

describe('A Payme payment of an order with a service fee', () => {
  it('Perform settles the whole total, fee included, once', async () => {
    const { store, perform, notifications } = build();

    const first = await perform();
    const again = await perform();

    expect(first.result.state).toBe(2);
    expect(again.result).toEqual(first.result);
    expect(store.order('ord_1').status).toBe(OrderStatus.PAID);
    expect(store.payment('pay_1')).toMatchObject({
      status: 'PAID',
      amountUzs: 645_000,
    });
    expect(
      store.history().filter((h) => h.status === OrderStatus.PAID),
    ).toHaveLength(1);
    expect(notifications.emit).toHaveBeenCalledTimes(1);
  });

  it('a full refund through Payme returns the fee with everything else, and records which part it was', async () => {
    const { store, perform, cancel, position } = build();
    await perform();

    const res = await cancel();

    expect(res.result.state).toBe(-2);
    expect(store.order('ord_1').status).toBe(OrderStatus.REFUNDED);
    expect(store.refunds()).toEqual([
      expect.objectContaining({
        amountUzs: 645_000,
        serviceFeeUzs: 20_000,
        method: 'PROVIDER',
      }),
    ]);
    const p = await position();
    expect(Number(p.remaining)).toBe(0);
    expect({
      charged: Number(p.serviceFee.charged),
      refunded: Number(p.serviceFee.refunded),
      retained: Number(p.serviceFee.retained),
    }).toEqual({ charged: 20_000, refunded: 20_000, retained: 0 });
  });

  it('a repeated Cancel refunds nothing twice', async () => {
    const { store, perform, cancel } = build();
    await perform();

    const first = await cancel();
    const second = await cancel();

    expect(second.result).toEqual(first.result);
    expect(store.refunds()).toHaveLength(1);
    expect(
      store.history().filter((h) => h.status === OrderStatus.REFUNDED),
    ).toHaveLength(1);
  });

  it('after a partial cash refund of goods, the reversal takes the rest, fee included', async () => {
    const { store, perform, cancel, position } = build();
    await perform();
    // A manager gave back one part in cash first, leaving the fee where it was.
    await store.prisma.financialRefund.create({
      data: {
        id: 'rfd_cash',
        orderId: 'ord_1',
        paymentId: 'pay_1',
        amountUzs: 100_000,
        serviceFeeUzs: 0,
        method: 'CASH',
      },
    });
    expect(Number((await position()).serviceFee.retained)).toBe(20_000);

    await cancel();

    const created = store.refunds().find((r) => r.id !== 'rfd_cash');
    expect(created).toMatchObject({
      amountUzs: 545_000,
      serviceFeeUzs: 20_000,
    });
    expect(Number((await position()).serviceFee.retained)).toBe(0);
  });

  it('a fee an earlier entry already gave back is not given back twice', async () => {
    const { store, perform, cancel } = build();
    await perform();
    await store.prisma.financialRefund.create({
      data: {
        id: 'rfd_fee',
        orderId: 'ord_1',
        paymentId: 'pay_1',
        amountUzs: 20_000,
        serviceFeeUzs: 20_000,
        method: 'BANK_TRANSFER',
      },
    });

    await cancel();

    const created = store.refunds().find((r) => r.id !== 'rfd_fee');
    expect(created).toMatchObject({ amountUzs: 625_000, serviceFeeUzs: 0 });
  });

  it('a delivered order cannot be cancelled through Payme: the fee stays, and nothing moves', async () => {
    const { store, perform, cancel } = build();
    await perform();
    await store.prisma.order.updateMany({
      where: { id: 'ord_1' },
      data: { status: OrderStatus.DELIVERED },
    });

    const res = await cancel();

    expect(res.error.code).toBe(-31007);
    expect(store.refunds()).toEqual([]);
    expect(store.payment('pay_1').status).toBe('PAID');
  });

  it('cancelling before Perform returns nothing, because nothing was taken', async () => {
    const { store, cancel, position } = build();

    const res = await cancel(3);

    expect(res.result.state).toBe(-1);
    expect(store.refunds()).toEqual([]);
    expect(Number((await position()).serviceFee.charged)).toBe(0);
    // The order stays payable for another attempt, with its fee as it was.
    expect(store.order('ord_1')).toMatchObject({
      status: OrderStatus.PENDING_PAYMENT,
      serviceFeeUzs: 20_000,
      totalUzs: 645_000,
    });
  });
});

describe('A Payme refund of an order with several sellers (Phase 3)', () => {
  /** Dealer A 350 000, dealer B 250 000, a 20 000 fee and 25 000 of delivery. */
  const MULTI = {
    ...ORDER,
    items: [
      // Dealer A at 5%, dealer B with no commission configured.
      { sellerId: 'dealer_a', lineTotalUzs: 350_000, commissionUzs: 17_500 },
      { sellerId: 'dealer_b', lineTotalUzs: 250_000, commissionUzs: 0 },
    ],
  };
  function multi() {
    const store = settlementStore({
      payments: [
        pendingPaymePayment({
          amountUzs: ORDER.totalUzs,
          amountTiyin: BigInt(ORDER.totalUzs * 100),
          providerCancelTime: null,
          cancelReason: null,
        }),
      ],
      orders: [order(OrderStatus.PENDING_PAYMENT, MULTI)],
    });
    const settlement = new SettlementService(
      store.prisma as any,
      { emit: jest.fn().mockResolvedValue(undefined) } as any,
      { emit: jest.fn() } as any,
      new OrderStatusService(store.prisma as any),
      CONFIG,
    );
    const payme = new PaymeService(
      store.prisma as any,
      CONFIG,
      settlement,
      {} as any,
    );
    const rpc = (method: string, params: Record<string, unknown>) =>
      payme.handle(AUTH, { id: 1, method, params }) as Promise<any>;
    return {
      store,
      perform: () => rpc('PerformTransaction', { id: 'pmt-xyz' }),
      cancel: () => rpc('CancelTransaction', { id: 'pmt-xyz', reason: 5 }),
    };
  }

  it('gives back each seller’s goods to the seller, and delivery and the fee as such', async () => {
    const { store, perform, cancel } = multi();
    await perform();

    await cancel();

    expect(store.refunds()).toEqual([
      expect.objectContaining({
        amountUzs: 645_000,
        serviceFeeUzs: 20_000,
        deliveryUzs: 25_000,
        allocations: [
          { sellerId: 'dealer_a', amountUzs: 350_000, commissionUzs: 17_500 },
          { sellerId: 'dealer_b', amountUzs: 250_000, commissionUzs: 0 },
        ],
      }),
    ]);
  });

  it('after a seller’s goods went back by hand, the reversal gives back only what is left', async () => {
    const { store, perform, cancel } = multi();
    await perform();
    await store.prisma.financialRefund.create({
      data: {
        id: 'rfd_cash',
        orderId: 'ord_1',
        paymentId: 'pay_1',
        amountUzs: 250_000,
        method: 'CASH',
        allocations: { create: [{ sellerId: 'dealer_b', amountUzs: 250_000 }] },
      },
    });

    await cancel();

    const created = store.refunds().find((r) => r.id !== 'rfd_cash');
    expect(created).toMatchObject({
      amountUzs: 395_000,
      serviceFeeUzs: 20_000,
      deliveryUzs: 25_000,
      allocations: [
        { sellerId: 'dealer_a', amountUzs: 350_000, commissionUzs: 17_500 },
      ],
    });
  });
});
