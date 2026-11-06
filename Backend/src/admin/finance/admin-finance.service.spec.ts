/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- the Prisma double and jest matchers are untyped */
// The seller ledger: what each seller is owed and was paid, payouts and the holds that stop
// them. Mator takes no commission from sellers: its own money is the service fee and delivery.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  OrderStatus,
  PaymentStatus,
  PayoutMethod,
  Prisma,
  RefundMethod,
} from '@prisma/client';
import { AdminFinanceService } from './admin-finance.service';
import { RecordPayoutDto } from './dto/payout.dto';
import { BLOCKED_ORDER, PAYABLE_ORDER, TOOK_MONEY } from './seller-ledger';

const ACTOR = { id: 'adm_1', email: 'mgr@mator.test', name: 'Mira' };
const D = (n: number) => new Prisma.Decimal(n);

/**
 * Dealer A: order 1 delivered (400 000 of goods), order 2 still on its way (200 000). 100 000 of
 * order 1's goods went back AFTER 350 000 had been sent. Dealer B: 250 000 on order 1, nothing
 * sent. Order 1: 650 000 of goods + 20 000 fee + 25 000 delivery, paid through Payme; order 2:
 * 200 000 + 10 000 fee, pickup, paid in cash.
 *
 * `order2`: 'delivered' makes order 2 payable too; 'held' holds it back from payouts.
 */
function world(
  over: {
    order2?: 'on_its_way' | 'delivered' | 'held';
    duplicate?: boolean;
    seller?: boolean;
  } = {},
) {
  const order2 = over.order2 ?? 'on_its_way';
  const sums = (pairs: [string, number][], key: string) =>
    pairs.map(([sellerId, x]) => ({ sellerId, _sum: { [key]: D(x) } }));
  const lines = (order: unknown): [string, number][] => {
    if (order === TOOK_MONEY) {
      return [
        ['dealer_a', 600_000],
        ['dealer_b', 250_000],
      ];
    }
    if (order === PAYABLE_ORDER) {
      return [
        ['dealer_a', order2 === 'delivered' ? 600_000 : 400_000],
        ['dealer_b', 250_000],
      ];
    }
    if (order === BLOCKED_ORDER) {
      return order2 === 'held' ? [['dealer_a', 200_000]] : [];
    }
    throw new Error('unexpected order filter');
  };
  // The refund was of order 1, which is payable in every case here.
  const refunded = (order: unknown): [string, number][] =>
    order === undefined || order === PAYABLE_ORDER
      ? [['dealer_a', 100_000]]
      : [];
  const prisma: any = {
    orderItem: {
      groupBy: jest.fn(({ where }) =>
        Promise.resolve(sums(lines(where.order), 'lineTotalUzs')),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    financialRefundAllocation: {
      groupBy: jest.fn(({ where }) =>
        Promise.resolve(sums(refunded(where.refund.order), 'amountUzs')),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    sellerPayout: {
      groupBy: jest.fn(() =>
        Promise.resolve([
          { sellerId: 'dealer_a', _sum: { amountUzs: D(350_000) } },
        ]),
      ),
      findFirst: jest
        .fn()
        .mockResolvedValue(over.duplicate ? { id: 'spo_0' } : null),
      create: jest.fn().mockResolvedValue({ id: 'spo_1' }),
      findUnique: jest.fn().mockResolvedValue({ sellerId: 'dealer_b' }),
      findUniqueOrThrow: jest.fn(({ select }) =>
        Promise.resolve(
          'paidAt' in select
            ? {
                id: 'spo_1',
                sellerId: 'dealer_b',
                amountUzs: D(100_000),
                method: 'BANK_TRANSFER',
                reference: 'PP-17',
                note: null,
                paidAt: new Date('2026-11-06T09:00:00Z'),
                createdByEmail: ACTOR.email,
                createdByName: ACTOR.name,
                voidedAt: null,
                voidedByEmail: null,
                voidReason: null,
                createdAt: new Date('2026-11-06T09:00:00Z'),
              }
            : {
                amountUzs: D(100_000),
                method: 'BANK_TRANSFER',
                reference: 'PP-17',
                voidedAt: null,
              },
        ),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    catalogSeller: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'dealer_a', name: 'Driver’s Village' },
        { id: 'dealer_b', name: 'Avto Ehtiyot' },
      ]),
    },
    order: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: {
          totalUzs: D(905_000),
          serviceFeeUzs: D(30_000),
          deliveryUzs: D(25_000),
        },
      }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({
        payoutHoldAt: null,
        payoutHoldReason: null,
      }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        payoutHoldAt: new Date(),
        payoutHoldReason: 'Return requested',
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    financialRefund: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: { amountUzs: D(100_000), serviceFeeUzs: D(0), deliveryUzs: D(0) },
      }),
    },
    // Order 1 came in through Payme; the refund went back by hand.
    payment: {
      aggregate: jest.fn(({ where }) =>
        Promise.resolve({
          _sum: {
            amountUzs: where.status.in.includes(PaymentStatus.PAID)
              ? D(695_000)
              : D(0),
          },
        }),
      ),
    },
    $queryRaw: jest.fn(() =>
      Promise.resolve(
        over.seller === false ? [] : [{ id: 'dealer_b', name: 'Avto Ehtiyot' }],
      ),
    ),
  };
  prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prisma));
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new AdminFinanceService(prisma, audit as never),
    prisma,
    audit,
  };
}

const conflictCode = async (work: Promise<unknown>) => {
  const err = (await work.catch((e: unknown) => e)) as ConflictException;
  expect(err).toBeInstanceOf(ConflictException);
  return (err.getResponse() as { code: string }).code;
};

describe('AdminFinanceService.sellers', () => {
  it('owed: goods less refunds, less what was sent; a refund after a payout is a debt', async () => {
    const { service } = world();

    const res = await service.sellers();

    expect(res.data).toEqual([
      {
        sellerId: 'dealer_b',
        name: 'Avto Ehtiyot',
        soldUzs: 250_000,
        refundedUzs: 0,
        earnedUzs: 250_000,
        payableUzs: 250_000,
        blockedUzs: 0,
        pendingUzs: 0,
        paidOutUzs: 0,
        owedUzs: 250_000,
        payableNowUzs: 250_000,
        debtUzs: 0,
      },
      {
        sellerId: 'dealer_a',
        name: 'Driver’s Village',
        soldUzs: 600_000,
        refundedUzs: 100_000,
        // Theirs in full: no commission is taken off.
        earnedUzs: 500_000,
        // Order 1 only: 400 000 − 100 000.
        payableUzs: 300_000,
        blockedUzs: 0,
        // Order 2, on its way.
        pendingUzs: 200_000,
        paidOutUzs: 350_000,
        owedUzs: 150_000,
        payableNowUzs: 0,
        // Sent 350 000 against 300 000 payable once the goods came back.
        debtUzs: 50_000,
      },
    ]);
  });

  it('later earnings pay the debt off before anything more can be sent', async () => {
    const { service } = world({ order2: 'delivered' });

    const res = await service.sellers();
    const a = res.data.find((s) => s.sellerId === 'dealer_a')!;

    // Order 2 delivered: 500 000 payable, 350 000 already sent.
    expect(a).toMatchObject({
      payableUzs: 500_000,
      pendingUzs: 0,
      payableNowUzs: 150_000,
      debtUzs: 0,
    });
  });

  it('an order held back from payouts is blocked, not pending and not payable', async () => {
    const { service } = world({ order2: 'held' });

    const res = await service.sellers();
    const a = res.data.find((s) => s.sellerId === 'dealer_a')!;

    expect(a).toMatchObject({
      earnedUzs: 500_000,
      payableUzs: 300_000,
      blockedUzs: 200_000,
      pendingUzs: 0,
    });
    expect(res.meta.sellersBlocked).toBe(200_000);
  });

  it('the totals: what buyers paid apart from Mator’s income, which is the fee and delivery it keeps', async () => {
    const { service } = world();

    const res = await service.sellers();

    expect(res.meta).toEqual({
      paidByBuyers: 905_000,
      refundedToBuyers: 100_000,
      goodsSold: 850_000,
      goodsRefunded: 100_000,
      serviceFeeCharged: 30_000,
      // The refund gave back goods only: the fee and delivery stay Mator's.
      serviceFeeRefunded: 0,
      matorServiceFee: 30_000,
      deliveryCharged: 25_000,
      deliveryRefunded: 0,
      delivery: 25_000,
      matorIncome: 55_000,
      paymeReceived: 695_000,
      paymeRefunded: 0,
      sellersEarned: 750_000,
      sellersPayable: 550_000,
      sellersBlocked: 0,
      sellersPaidOut: 350_000,
      // What Mator owes dealer B and dealer A; dealer A's debt is apart.
      sellersOwed: 400_000,
      sellersPayableNow: 250_000,
      sellersDebt: 50_000,
    });
  });

  it('pays only for delivered, paid orders with nothing under way', async () => {
    const { service, prisma } = world();

    await service.sellers();

    const unconfirmedPaymeRefund = {
      voidedAt: null,
      method: RefundMethod.PROVIDER,
      providerConfirmedAt: null,
    };
    expect(PAYABLE_ORDER).toEqual({
      statusHistory: { some: { status: OrderStatus.PAID } },
      status: OrderStatus.DELIVERED,
      payoutHoldAt: null,
      financialRefunds: { none: unconfirmedPaymeRefund },
    });
    expect(BLOCKED_ORDER).toEqual({
      statusHistory: { some: { status: OrderStatus.PAID } },
      OR: [
        { payoutHoldAt: { not: null } },
        { financialRefunds: { some: unconfirmedPaymeRefund } },
      ],
    });
    expect(prisma.orderItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sellerId: { not: null }, order: PAYABLE_ORDER },
        _sum: { lineTotalUzs: true },
      }),
    );
    expect(prisma.financialRefundAllocation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { refund: { voidedAt: null, order: PAYABLE_ORDER } },
        _sum: { amountUzs: true },
      }),
    );
    expect(prisma.sellerPayout.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { voidedAt: null } }),
    );
  });
});

describe('AdminFinanceService.seller', () => {
  it('each order the seller sold on, net of what went back, and where it stands for a payout', async () => {
    const { service, prisma } = world();
    const placed = new Date('2026-11-01T10:00:00Z');
    prisma.orderItem.findMany.mockResolvedValue([
      {
        orderId: 'ord_2',
        lineTotalUzs: D(200_000),
        order: {
          status: OrderStatus.SHIPPED,
          createdAt: placed,
          payoutHoldReason: null,
        },
      },
      {
        orderId: 'ord_1',
        lineTotalUzs: D(300_000),
        order: {
          status: OrderStatus.DELIVERED,
          createdAt: placed,
          payoutHoldReason: null,
        },
      },
      {
        orderId: 'ord_1',
        lineTotalUzs: D(100_000),
        order: {
          status: OrderStatus.DELIVERED,
          createdAt: placed,
          payoutHoldReason: null,
        },
      },
    ]);
    prisma.financialRefundAllocation.findMany.mockResolvedValue([
      { amountUzs: D(100_000), refund: { orderId: 'ord_1' } },
    ]);
    prisma.order.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.status === OrderStatus.DELIVERED ? [{ id: 'ord_1' }] : [],
      ),
    );

    const res = await service.seller('dealer_a');

    expect(res.data.orders).toEqual([
      {
        orderId: 'ord_2',
        status: 'shipped',
        createdAt: placed.toISOString(),
        payable: false,
        blocked: false,
        payoutHold: null,
        sold: 200_000,
        refunded: 0,
        net: 200_000,
      },
      {
        orderId: 'ord_1',
        status: 'delivered',
        createdAt: placed.toISOString(),
        payable: true,
        blocked: false,
        payoutHold: null,
        sold: 400_000,
        refunded: 100_000,
        net: 300_000,
      },
    ]);
    expect(res.data.balance).toMatchObject({ debtUzs: 50_000 });
  });

  it('404s on a seller with no money and no payouts on record', async () => {
    const { service, prisma } = world();
    prisma.orderItem.groupBy.mockResolvedValue([]);
    prisma.financialRefundAllocation.groupBy.mockResolvedValue([]);
    prisma.sellerPayout.groupBy.mockResolvedValue([]);

    await expect(service.seller('nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AdminFinanceService.recordPayout', () => {
  const payout = (over: Partial<RecordPayoutDto> = {}): RecordPayoutDto => ({
    amountUzs: 250_000,
    method: PayoutMethod.BANK_TRANSFER,
    reference: 'PP-18',
    ...over,
  });

  it('records money sent, up to what is payable now, with its audit', async () => {
    const { service, prisma, audit } = world();

    await service.recordPayout('dealer_b', payout(), { actor: ACTOR });

    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.sellerPayout.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sellerId: 'dealer_b',
          amountUzs: D(250_000),
          reference: 'PP-18',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAuditAction.SELLER_PAYOUT_RECORDED,
        target: expect.objectContaining({ id: 'dealer_b' }),
      }),
      prisma,
    );
  });

  it('never more than is payable, and nothing while a seller owes Mator', async () => {
    const { service, prisma } = world();

    expect(
      await conflictCode(
        service.recordPayout('dealer_b', payout({ amountUzs: 250_000.01 })),
      ),
    ).toBe('PAYOUT_EXCEEDS_OWED');
    expect(
      await conflictCode(
        service.recordPayout('dealer_a', payout({ amountUzs: 1 })),
      ),
    ).toBe('PAYOUT_EXCEEDS_OWED');
    expect(prisma.sellerPayout.create).not.toHaveBeenCalled();
  });

  it('the same document again is a repeat, not a second payout', async () => {
    const { service, prisma } = world({ duplicate: true });

    expect(await conflictCode(service.recordPayout('dealer_b', payout()))).toBe(
      'PAYOUT_DUPLICATE_REFERENCE',
    );
    expect(prisma.sellerPayout.create).not.toHaveBeenCalled();
  });

  it('404s on an unknown seller, and refuses a date in the future', async () => {
    await expect(
      world({ seller: false }).service.recordPayout('nope', payout()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      world().service.recordPayout(
        'dealer_b',
        payout({ paidAt: new Date(Date.now() + 86_400_000).toISOString() }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AdminFinanceService.voidPayout', () => {
  it('keeps the entry, marks who and why, and leaves an audit entry', async () => {
    const { service, prisma, audit } = world();

    await service.voidPayout('spo_1', { reason: 'Typo' }, { actor: ACTOR });

    expect(prisma.sellerPayout.update).toHaveBeenCalledWith({
      where: { id: 'spo_1' },
      data: expect.objectContaining({
        voidReason: 'Typo',
        voidedById: 'adm_1',
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAuditAction.SELLER_PAYOUT_VOIDED,
      }),
      prisma,
    );
  });

  it('a repeat is refused rather than voiding twice', async () => {
    const { service, prisma } = world();
    prisma.sellerPayout.findUniqueOrThrow.mockResolvedValue({
      amountUzs: D(1),
      method: 'CASH',
      reference: 'x',
      voidedAt: new Date(),
    });

    expect(
      await conflictCode(service.voidPayout('spo_1', { reason: 'x' })),
    ).toBe('PAYOUT_ALREADY_VOIDED');
  });
});

describe('AdminFinanceService.setPayoutHold', () => {
  it('holds an order back from payouts, audited, and a repeat changes nothing', async () => {
    const { service, prisma, audit } = world();

    const res = await service.setPayoutHold(
      'ord_1',
      true,
      { reason: 'Return requested' },
      { actor: ACTOR },
    );

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord_1', payoutHoldAt: null },
      data: expect.objectContaining({ payoutHoldReason: 'Return requested' }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAuditAction.ORDER_PAYOUT_HOLD_SET,
      }),
      prisma,
    );
    expect(res.data).toMatchObject({ changed: true });

    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    audit.record.mockClear();
    const again = await service.setPayoutHold('ord_1', true, {
      reason: 'Return requested',
    });
    expect(again.data).toMatchObject({ changed: false });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('releases a held order, audited', async () => {
    const { service, prisma, audit } = world();

    await service.setPayoutHold('ord_1', false, {
      reason: 'Resolved, no refund',
    });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord_1', payoutHoldAt: { not: null } },
      data: { payoutHoldAt: null, payoutHoldReason: null },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAuditAction.ORDER_PAYOUT_HOLD_RELEASED,
      }),
      prisma,
    );
  });

  it('404s on an unknown order', async () => {
    const { service, prisma } = world();
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(
      service.setPayoutHold('nope', true, { reason: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
