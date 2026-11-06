/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- the Prisma double and jest matchers are untyped */
// Looking at the money rather than moving it: one order by whose it is, the tax receipts that
// need a person, and Payme's statement checked against the refund registry.

import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  PaymentProvider,
  PaymentStatus,
  PaymeFiscalReceiptType,
  Prisma,
  RefundMethod,
  RefundSource,
} from '@prisma/client';
import { AdminFinanceChecksService } from './admin-finance-checks.service';
import { PAYABLE_ORDER } from './seller-ledger';

const D = (n: number) => new Prisma.Decimal(n);
const AT = new Date('2026-11-01T10:00:00Z');
const { PERFORM, CANCEL } = PaymeFiscalReceiptType;
const noConfig = { get: () => undefined } as never;

const receipt = (
  type: PaymeFiscalReceiptType,
  statusCode: number | null,
  over: Record<string, unknown> = {},
) => ({
  type,
  receiptId: type === PERFORM ? 'R-100' : 'R-101',
  statusCode,
  message: null,
  fiscalSign: null,
  qrCodeUrl: null,
  fiscalDate: null,
  conflictCount: 0,
  ...over,
});

/** A registry entry as the admin views read it: 100 000 of dealer A's goods, back in cash. */
const refundRow = (over: Record<string, unknown> = {}) => ({
  id: 'rfd_1',
  orderId: 'ord_1',
  paymentId: 'pay_1',
  amountUzs: D(100_000),
  serviceFeeUzs: D(0),
  deliveryUzs: D(0),
  allocations: [{ sellerId: 'dealer_a', amountUzs: D(100_000) }],
  method: RefundMethod.CASH,
  source: RefundSource.MANUAL,
  reference: 'KO-7',
  fiscalReference: null,
  reason: 'Wrong part',
  refundedAt: AT,
  providerConfirmedAt: null,
  createdByEmail: 'mgr@mator.test',
  createdByName: 'Mira',
  voidedAt: null,
  voidedByEmail: null,
  voidReason: null,
  createdAt: AT,
  payment: { fiscalReceipts: [] },
  order: {
    status: 'DELIVERED',
    user: {
      displayName: 'Aziz',
      firstName: null,
      lastName: null,
      phoneE164: '+998901234567',
    },
  },
  ...over,
});

describe('AdminFinanceChecksService.order', () => {
  /**
   * 400 000 of dealer A's goods and 250 000 of dealer B's, a 20 000 fee and 25 000 delivery:
   * 695 000 paid through Payme. 100 000 of A's goods came back in cash, and the order is held
   * back from payouts while that is looked at.
   */
  const LEDGER_ORDER = {
    totalUzs: D(695_000),
    serviceFeeUzs: D(20_000),
    deliveryUzs: D(25_000),
    items: [
      { sellerId: 'dealer_a', lineTotalUzs: D(400_000) },
      { sellerId: 'dealer_b', lineTotalUzs: D(250_000) },
    ],
  };
  const line = (
    id: string,
    sellerId: string,
    title: string,
    price: number,
    quantity = 1,
  ) => ({
    id,
    title,
    quantity,
    priceUzs: D(price),
    lineTotalUzs: D(price * quantity),
    sellerId,
    providerId: null,
  });
  const VIEW_ORDER = {
    id: 'ord_1',
    status: 'DELIVERED',
    paymentType: 'PAYME',
    subtotalUzs: D(650_000),
    discountUzs: D(0),
    serviceFeeUzs: D(20_000),
    deliveryUzs: D(25_000),
    totalUzs: D(695_000),
    payoutHoldAt: AT,
    payoutHoldReason: 'Return requested',
    items: [
      line('oi_1', 'dealer_a', 'Brake pads', 200_000, 2),
      line('oi_2', 'dealer_b', 'Oil filter', 250_000),
    ],
    statusHistory: [{ id: 'osh_paid' }],
    payments: [
      {
        id: 'pay_1',
        provider: PaymentProvider.PAYME,
        status: PaymentStatus.PAID,
        amountUzs: D(695_000),
        providerTransactionId: 'tx_1',
        paidAt: AT,
        fiscalReceipts: [receipt(PERFORM, 0)],
      },
    ],
    financialRefunds: [
      refundRow({
        payment: {
          fiscalReceipts: [
            { type: PERFORM, receiptId: 'R-100', statusCode: 0 },
          ],
        },
      }),
    ],
  };

  function setup() {
    const prisma: any = {
      order: {
        findUnique: jest.fn(({ select }) =>
          Promise.resolve(select.payments ? VIEW_ORDER : LEDGER_ORDER),
        ),
        count: jest.fn().mockResolvedValue(0),
      },
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'pay_1', amountUzs: D(695_000), status: PaymentStatus.PAID },
          ]),
      },
      financialRefund: {
        findMany: jest.fn().mockResolvedValue([
          {
            amountUzs: D(100_000),
            serviceFeeUzs: D(0),
            deliveryUzs: D(0),
            paymentId: 'pay_1',
            allocations: [{ sellerId: 'dealer_a', amountUzs: D(100_000) }],
          },
        ]),
      },
      orderStatusHistory: { count: jest.fn().mockResolvedValue(1) },
      catalogSeller: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'dealer_a', name: 'Driver’s Village' },
          { id: 'dealer_b', name: 'Avto Ehtiyot' },
        ]),
      },
    };
    return {
      service: new AdminFinanceChecksService(prisma, noConfig),
      prisma,
    };
  }

  it('each seller’s goods and what they net, in full; the refund touches only its seller', async () => {
    const { service } = setup();

    const res = await service.order('ord_1');

    expect(res.data.position.sellers).toEqual([
      {
        sellerId: 'dealer_a',
        name: 'Driver’s Village',
        charged: 400_000,
        refunded: 100_000,
        remaining: 300_000,
        net: 300_000,
      },
      {
        sellerId: 'dealer_b',
        name: 'Avto Ehtiyot',
        charged: 250_000,
        refunded: 0,
        remaining: 250_000,
        net: 250_000,
      },
    ]);
    // Each line, and who sold it.
    expect(res.data.items).toEqual([
      {
        id: 'oi_1',
        title: 'Brake pads',
        quantity: 2,
        price: 200_000,
        lineTotal: 400_000,
        sellerId: 'dealer_a',
        sellerName: 'Driver’s Village',
        providerId: null,
      },
      {
        id: 'oi_2',
        title: 'Oil filter',
        quantity: 1,
        price: 250_000,
        lineTotal: 250_000,
        sellerId: 'dealer_b',
        sellerName: 'Avto Ehtiyot',
        providerId: null,
      },
    ]);
    // A goods-only refund leaves the fee and delivery where they were.
    expect(res.data.position).toMatchObject({
      received: 695_000,
      refunded: 100_000,
      remaining: 595_000,
      serviceFee: { charged: 20_000, refunded: 0, retained: 20_000 },
      delivery: { charged: 25_000, refunded: 0, remaining: 25_000 },
      unattributed: { charged: 0, refunded: 0, remaining: 0 },
    });
    expect(res.data.charges).toEqual({
      itemsSubtotal: 650_000,
      discount: 0,
      serviceFee: 20_000,
      delivery: 25_000,
      total: 695_000,
    });
  });

  it('says whether it can be paid out, and why not', async () => {
    const { service, prisma } = setup();

    const res = await service.order('ord_1');

    expect(prisma.order.count).toHaveBeenCalledWith({
      where: { ...PAYABLE_ORDER, id: 'ord_1' },
    });
    expect(res.data.payout).toEqual({
      payable: false,
      holdAt: AT.toISOString(),
      holdReason: 'Return requested',
      blockers: ['payout_hold'],
    });
  });

  it('names every reason a payout is blocked, and none once nothing stands in the way', async () => {
    const { service, prisma } = setup();
    prisma.order.findUnique.mockImplementation(({ select }) =>
      Promise.resolve(
        select.payments
          ? {
              ...VIEW_ORDER,
              status: 'SHIPPED',
              statusHistory: [],
              financialRefunds: [
                refundRow({ method: RefundMethod.PROVIDER }),
                refundRow({
                  id: 'rfd_old',
                  method: RefundMethod.PROVIDER,
                  voidedAt: AT,
                }),
              ],
            }
          : LEDGER_ORDER,
      ),
    );
    expect((await service.order('ord_1')).data.payout.blockers).toEqual([
      'no_money_taken',
      'not_delivered',
      'payout_hold',
      'refund_awaiting_payme',
    ]);

    prisma.order.findUnique.mockImplementation(({ select }) =>
      Promise.resolve(
        select.payments
          ? { ...VIEW_ORDER, payoutHoldAt: null, payoutHoldReason: null }
          : LEDGER_ORDER,
      ),
    );
    expect((await service.order('ord_1')).data.payout.blockers).toEqual([]);
  });

  it('shows the cash refund as having no receipt, and the sale receipt beside the payment', async () => {
    const { service } = setup();

    const res = await service.order('ord_1');

    expect(res.data.refunds).toEqual([
      expect.objectContaining({
        amount: 100_000,
        serviceFee: 0,
        delivery: 0,
        allocations: [{ sellerId: 'dealer_a', amount: 100_000 }],
        fiscalReceipt: { status: 'missing', receiptId: null },
        // The sale receipt the return receipt has to cite.
        saleReceipt: { receiptId: 'R-100', statusCode: 0 },
      }),
    ]);
    expect(res.data.payments[0].receipts).toEqual({
      sale: expect.objectContaining({ receiptId: 'R-100', statusCode: 0 }),
      cancellation: null,
    });
  });

  it('404s on an unknown order', async () => {
    const { service, prisma } = setup();
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(service.order('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AdminFinanceChecksService.fiscalIssues', () => {
  const payment = (
    id: string,
    status: PaymentStatus,
    fiscalReceipts: ReturnType<typeof receipt>[],
  ) => ({
    id,
    orderId: `ord_${id}`,
    provider: PaymentProvider.PAYME,
    status,
    amountUzs: D(210_000),
    providerTransactionId: `tx_${id}`,
    paidAt: AT,
    fiscalReceipts,
  });

  function setup() {
    const prisma: any = {
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            payment('p1', PaymentStatus.PAID, []),
            payment('p2', PaymentStatus.REFUNDED, [
              receipt(PERFORM, 0),
              receipt(CANCEL, 3),
            ]),
            payment('p3', PaymentStatus.PAID, [
              receipt(PERFORM, 0, { conflictCount: 2 }),
            ]),
            payment('p4', PaymentStatus.PAID, [receipt(PERFORM, 0)]),
            payment('p5', PaymentStatus.REFUNDED, [receipt(PERFORM, 0)]),
          ]),
      },
      financialRefund: {
        findMany: jest.fn(({ where }) =>
          Promise.resolve(
            where.fiscalReference
              ? [
                  refundRow({
                    id: 'rfd_3',
                    method: RefundMethod.TERMINAL,
                    fiscalReference: 'OFD-555',
                  }),
                ]
              : [
                  refundRow(),
                  refundRow({
                    id: 'rfd_2',
                    method: RefundMethod.PROVIDER,
                    reference: 'tx_9',
                  }),
                ],
          ),
        ),
      },
    };
    return {
      service: new AdminFinanceChecksService(prisma, noConfig),
      prisma,
    };
  }

  it('lists each payment’s receipt problems, and leaves out the ones in order', async () => {
    const { service } = setup();

    const res = await service.fiscalIssues({});

    expect(
      res.data.payments.map((p) => [p.paymentId, p.orderId, p.problems]),
    ).toEqual([
      ['p1', 'ord_p1', ['sale_receipt_missing']],
      ['p2', 'ord_p2', ['cancel_receipt_rejected']],
      ['p3', 'ord_p3', ['receipt_conflict']],
      ['p5', 'ord_p5', ['cancel_receipt_missing']],
    ]);
    // The cancellation is shown with the sale receipt it reverses.
    expect(res.data.payments[1].receipts.cancellation).toMatchObject({
      receiptId: 'R-101',
      reverses: 'R-100',
    });
  });

  it('lists refunds with no receipt to show for them: outside Payme with none recorded, or not yet reversed by Payme', async () => {
    const { service, prisma } = setup();

    const res = await service.fiscalIssues({});

    expect(prisma.financialRefund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          voidedAt: null,
          source: RefundSource.MANUAL,
          refundedAt: { lte: expect.any(Date) },
          OR: [
            { method: { not: RefundMethod.PROVIDER }, fiscalReference: null },
            { method: RefundMethod.PROVIDER, providerConfirmedAt: null },
          ],
        },
      }),
    );
    expect(res.data.refunds.map((r) => [r.id, r.fiscalReceipt.status])).toEqual(
      [
        ['rfd_1', 'missing'],
        ['rfd_2', 'awaiting_payme'],
      ],
    );
  });

  it('lists apart the refunds outside Payme whose receipt only an operator stated: nothing confirmed it', async () => {
    const { service, prisma } = setup();

    const res = await service.fiscalIssues({});

    expect(prisma.financialRefund.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          voidedAt: null,
          source: RefundSource.MANUAL,
          refundedAt: { lte: expect.any(Date) },
          method: { not: RefundMethod.PROVIDER },
          fiscalReference: { not: null },
        },
      }),
    );
    expect(
      res.data.statedRefunds.map((r) => [r.id, r.fiscalReceipt.status]),
    ).toEqual([['rfd_3', 'stated_by_operator']]);
  });

  it('gives Payme an hour by default before an absent receipt counts', async () => {
    const { service, prisma } = setup();

    await service.fiscalIssues({});
    const before: Date =
      prisma.financialRefund.findMany.mock.calls[0][0].where.refundedAt.lte;

    const waited = Date.now() - before.getTime();
    expect(waited).toBeGreaterThanOrEqual(60 * 60_000);
    expect(waited).toBeLessThan(60 * 60_000 + 5_000);
  });
});

describe('AdminFinanceChecksService.paymeStatement: GetStatement against the registry', () => {
  const { PAID, REFUNDED, CANCELLED } = PaymentStatus;
  /** A Payme transaction, its order's total, and the refunds the registry holds for it. */
  const tx = (
    id: string,
    state: number,
    status: PaymentStatus,
    tiyin: number,
    total: number,
    refunds: number[] = [],
  ) => ({
    id: `pay_${id}`,
    orderId: `ord_${id}`,
    provider: PaymentProvider.PAYME,
    providerTransactionId: `tx_${id}`,
    providerCreateTime: BigInt(1_762_000_000_000),
    providerPerformTime:
      state === 1 || state === -1 ? null : BigInt(1_762_000_001_000),
    providerCancelTime: state < 0 ? BigInt(1_762_000_002_000) : null,
    providerState: state,
    cancelReason: state < 0 ? 5 : null,
    amountTiyin: BigInt(tiyin),
    amountUzs: D(tiyin / 100),
    status,
    order: { totalUzs: D(total) },
    financialRefunds: refunds.map((a) => ({ amountUzs: D(a) })),
  });

  function setup() {
    const prisma: any = {
      payment: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            tx('a', 2, PAID, 69_500_000, 695_000),
            tx('b', -2, REFUNDED, 21_000_000, 210_000, [210_000]),
            tx('c', -2, REFUNDED, 21_000_000, 210_000, [100_000]),
            tx('d', 2, REFUNDED, 21_000_000, 210_000, [210_000]),
            tx('e', 2, PAID, 69_400_000, 695_000),
            tx('f', -1, CANCELLED, 21_000_000, 210_000, [50_000]),
            tx('g', 2, PAID, 69_500_000, 695_000, [600_000, 95_000]),
          ]),
      },
    };
    return {
      service: new AdminFinanceChecksService(prisma, noConfig),
      prisma,
    };
  }

  it('reads exactly the list GetStatement gives Payme: the window, oldest first', async () => {
    const { service, prisma } = setup();

    await service.paymeStatement({ from: 1_000, to: 2_000 });

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider: PaymentProvider.PAYME,
          providerTransactionId: { not: null },
          providerCreateTime: { gte: BigInt(1_000), lte: BigInt(2_000) },
        },
        orderBy: [{ providerCreateTime: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('flags each disagreement with the registry, and nothing where they agree', async () => {
    const { service } = setup();

    const res = await service.paymeStatement({ from: 1_000, to: 2_000 });

    expect(res.data.map((t) => [t.id, t.problems])).toEqual([
      ['tx_a', []],
      ['tx_b', []],
      ['tx_c', ['refund_not_in_registry']],
      ['tx_d', ['state_mismatch', 'refunded_outside_payme']],
      ['tx_e', ['amount_mismatch']],
      ['tx_f', ['refund_without_money']],
      ['tx_g', ['refunded_outside_payme']],
    ]);
    expect(res.meta).toEqual({ count: 7, withProblems: 5 });
  });

  it('each transaction as Payme knows it, beside the payment and the registry', async () => {
    const { service } = setup();

    const res = await service.paymeStatement({ from: 1_000, to: 2_000 });

    expect(res.data[2]).toEqual({
      id: 'tx_c',
      time: 1_762_000_000_000,
      amount: 21_000_000,
      account: { order_id: 'ord_c' },
      create_time: 1_762_000_000_000,
      perform_time: 1_762_000_001_000,
      cancel_time: 1_762_000_002_000,
      transaction: 'pay_c',
      state: -2,
      reason: 5,
      paymentStatus: 'refunded',
      refundedInRegistry: 100_000,
      problems: ['refund_not_in_registry'],
    });
  });

  it('refuses a window that runs backwards or spans more than 92 days', async () => {
    const { service, prisma } = setup();
    const day = 86_400_000;

    await expect(
      service.paymeStatement({ from: 2_000, to: 1_000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.paymeStatement({ from: 0, to: 92 * day + 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();

    await service.paymeStatement({ from: 0, to: 92 * day });
    expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
  });
});
