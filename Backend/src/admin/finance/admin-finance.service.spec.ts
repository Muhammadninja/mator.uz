/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- the Prisma double and jest matchers are untyped */
// The seller ledger: what each seller is owed and was paid, Mator's commission, payouts and the
// holds that stop them.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  OrderStatus,
  PayoutMethod,
  Prisma,
  RefundMethod,
} from '@prisma/client';
import { AdminFinanceService } from './admin-finance.service';
import { RecordPayoutDto } from './dto/payout.dto';
import { PAYABLE_ORDER } from './seller-ledger';

const ACTOR = { id: 'adm_1', email: 'mgr@mator.test', name: 'Mira' };
const D = (n: number) => new Prisma.Decimal(n);

/**
 * Dealer A, at 5%: order 1 delivered (400 000 of goods, 20 000 commission), order 2 still on its
 * way (200 000, 10 000). 100 000 of order 1's goods went back AFTER 300 000 had been sent.
 * Dealer B, no commission: 250 000 on order 1, nothing sent.
 * Order 1: 650 000 of goods + 20 000 fee + 25 000 delivery; order 2: 200 000 + 10 000 fee, pickup.
 */
function world(
  over: {
    payable?: 'order1' | 'both';
    duplicate?: boolean;
    seller?: boolean;
  } = {},
) {
  const rows = (pairs: [string, number, number][], a: string, b: string) =>
    pairs.map(([sellerId, x, y]) => ({
      sellerId,
      _sum: { [a]: D(x), [b]: D(y) },
    }));
  const payableLines: [string, number, number][] =
    over.payable === 'both'
      ? [
          ['dealer_a', 600_000, 30_000],
          ['dealer_b', 250_000, 0],
        ]
      : [
          ['dealer_a', 400_000, 20_000],
          ['dealer_b', 250_000, 0],
        ];
  const prisma: any = {
    orderItem: {
      groupBy: jest.fn(({ where }) =>
        Promise.resolve(
          'payoutHoldAt' in where.order
            ? rows(payableLines, 'lineTotalUzs', 'commissionUzs')
            : rows(
                [
                  ['dealer_a', 600_000, 30_000],
                  ['dealer_b', 250_000, 0],
                ],
                'lineTotalUzs',
                'commissionUzs',
              ),
        ),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { commissionUzs: D(30_000) } }),
    },
    financialRefundAllocation: {
      groupBy: jest.fn(() =>
        Promise.resolve(
          rows([['dealer_a', 100_000, 5_000]], 'amountUzs', 'commissionUzs'),
        ),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { commissionUzs: D(5_000) } }),
    },
    sellerPayout: {
      groupBy: jest.fn(() =>
        Promise.resolve([
          { sellerId: 'dealer_a', _sum: { amountUzs: D(300_000) } },
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
  it('owed: goods less refunds less net commission, less what was sent; a refund after a payout is a debt', async () => {
    const { service } = world();

    const res = await service.sellers();

    expect(res.data).toEqual([
      {
        sellerId: 'dealer_b',
        name: 'Avto Ehtiyot',
        soldUzs: 250_000,
        refundedUzs: 0,
        commissionUzs: 0,
        earnedUzs: 250_000,
        payableUzs: 250_000,
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
        // 30 000 charged, 5 000 went back with the refunded goods.
        commissionUzs: 25_000,
        earnedUzs: 475_000,
        // Order 1 only: 400 000 − 100 000 − (20 000 − 5 000).
        payableUzs: 285_000,
        paidOutUzs: 300_000,
        owedUzs: 175_000,
        payableNowUzs: 0,
        // Sent 300 000 against 285 000 payable once the goods came back.
        debtUzs: 15_000,
      },
    ]);
  });

  it('later earnings pay the debt off before anything more can be sent', async () => {
    const { service } = world({ payable: 'both' });

    const res = await service.sellers();
    const a = res.data.find((s) => s.sellerId === 'dealer_a')!;

    // Order 2 delivered: 475 000 payable, 300 000 already sent.
    expect(a).toMatchObject({
      payableUzs: 475_000,
      payableNowUzs: 175_000,
      debtUzs: 0,
    });
  });

  it('Mator’s figures: what buyers paid, and the fee, commission and delivery it keeps', async () => {
    const { service } = world();

    const res = await service.sellers();

    expect(res.meta).toEqual({
      paidByBuyers: 905_000,
      refundedToBuyers: 100_000,
      // The refund gave back goods only: the fee and delivery stay Mator's.
      matorServiceFee: 30_000,
      matorCommission: 25_000,
      delivery: 25_000,
    });
  });

  it('pays only for delivered, paid orders with nothing under way', async () => {
    const { service, prisma } = world();

    await service.sellers();

    expect(PAYABLE_ORDER).toEqual({
      statusHistory: { some: { status: OrderStatus.PAID } },
      status: OrderStatus.DELIVERED,
      payoutHoldAt: null,
      financialRefunds: {
        none: {
          voidedAt: null,
          method: RefundMethod.PROVIDER,
          providerConfirmedAt: null,
        },
      },
    });
    expect(prisma.orderItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sellerId: { not: null }, order: PAYABLE_ORDER },
      }),
    );
    expect(prisma.financialRefundAllocation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { refund: { voidedAt: null, order: PAYABLE_ORDER } },
      }),
    );
    expect(prisma.sellerPayout.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { voidedAt: null } }),
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
