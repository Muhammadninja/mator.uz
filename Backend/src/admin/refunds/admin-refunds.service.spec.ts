// The rules of the refund registry. What it must never do matters as much as what it
// records: it never touches a status, never lets more go back than came in, and
// keeps a wrong entry on record instead of deleting it.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, Prisma, RefundMethod } from '@prisma/client';
import { AdminRefundsService } from './admin-refunds.service';
import { RecordRefundDto } from './dto/record-refund.dto';

const ACTOR = { id: 'adm_1', email: 'mgr@mator.test', name: 'Mira' };

function build(state: {
  received?: number;
  refunded?: number;
  /** The order's service fee, and how much of it entries already gave back. */
  fee?: number;
  feeRefunded?: number;
  duplicate?: boolean;
  orderExists?: boolean;
  entry?: Record<string, unknown> | null;
  /** The written entry as it is read back, where it differs from a Payme refund. */
  written?: Record<string, unknown>;
}) {
  const row = {
    id: 'rfd_1',
    orderId: 'ord_1',
    paymentId: 'pay_1',
    amountUzs: 100,
    serviceFeeUzs: 0,
    deliveryUzs: 0,
    allocations: [],
    fiscalReference: null,
    method: RefundMethod.PROVIDER,
    source: 'MANUAL',
    reference: 'TX-1',
    reason: 'why',
    refundedAt: new Date('2026-11-01T00:00:00Z'),
    providerConfirmedAt: null,
    createdByEmail: ACTOR.email,
    createdByName: ACTOR.name,
    voidedAt: null,
    voidedByEmail: null,
    voidReason: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    order: {
      status: 'CANCELLED',
      user: {
        displayName: 'Buyer',
        firstName: null,
        lastName: null,
        phoneE164: '+998900000000',
      },
    },
    ...state.written,
  };
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValue(state.orderExists === false ? [] : [{ id: 'ord_1' }]),
    order: {
      findUnique: jest.fn().mockResolvedValue({
        totalUzs: state.received ?? 0,
        serviceFeeUzs: state.fee ?? 0,
      }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    payment: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          state.received ? [{ id: 'pay_1', amountUzs: state.received }] : [],
        ),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    orderStatusHistory: { count: jest.fn().mockResolvedValue(0) },
    catalogSeller: { findMany: jest.fn().mockResolvedValue([]) },
    financialRefund: {
      findMany: jest.fn().mockResolvedValue(
        state.refunded
          ? [
              {
                amountUzs: state.refunded,
                serviceFeeUzs: state.feeRefunded ?? 0,
              },
            ]
          : [],
      ),
      findFirst: jest
        .fn()
        .mockResolvedValue(state.duplicate ? { id: 'rfd_0' } : null),
      findUnique: jest
        .fn()
        .mockResolvedValue(state.entry === null ? null : { orderId: 'ord_1' }),
      findUniqueOrThrow: jest
        .fn()
        .mockImplementation(
          ({ select }: { select: Record<string, unknown> }) =>
            'order' in select
              ? row
              : {
                  amountUzs: 100,
                  method: RefundMethod.PROVIDER,
                  reference: 'TX-1',
                  voidedAt: null,
                  providerConfirmedAt: null,
                  ...state.entry,
                },
        ),
      create: jest.fn().mockResolvedValue({ id: 'rfd_1' }),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const alerts = { raise: jest.fn() };
  const service = new AdminRefundsService(
    prisma as never,
    audit as never,
    alerts as never,
  );
  return { service, tx, audit, alerts };
}

const dto = (over: Partial<RecordRefundDto> = {}): RecordRefundDto => ({
  amountUzs: 100,
  method: RefundMethod.PROVIDER,
  reference: 'TX-1',
  reason: 'Out of stock',
  ...over,
});

const conflictCode = async (work: Promise<unknown>) => {
  const err = (await work.catch((e: unknown) => e)) as ConflictException;
  expect(err).toBeInstanceOf(ConflictException);
  return (err.getResponse() as { code: string }).code;
};

describe('AdminRefundsService.record', () => {
  it('records the entry and the audit trail, in the same transaction', async () => {
    const { service, tx, audit } = build({ received: 100 });

    const res = await service.record('ord_1', dto(), { actor: ACTOR });

    expect(tx.financialRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'ord_1',
          paymentId: 'pay_1',
          method: RefundMethod.PROVIDER,
          reference: 'TX-1',
          createdById: ACTOR.id,
          createdByEmail: ACTOR.email,
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAuditAction.REFUND_RECORDED,
        actor: ACTOR,
        reason: 'Out of stock',
        target: expect.objectContaining({ id: 'ord_1' }),
      }),
      tx,
    );
    expect(res.data.amount).toBe(100);
  });

  it('locks the order before reading what is left', async () => {
    const { service, tx } = build({ received: 100 });

    await service.record('ord_1', dto());

    const lockedFirst = tx.$queryRaw.mock.invocationCallOrder[0];
    expect(lockedFirst).toBeLessThan(
      tx.payment.findMany.mock.invocationCallOrder[0],
    );
    expect(String(tx.$queryRaw.mock.calls[0][0])).toContain('FOR UPDATE');
  });

  it('never changes an order or a payment status', async () => {
    const { service, tx } = build({ received: 100 });

    await service.record('ord_1', dto());

    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
    for (const [args] of tx.order.updateMany.mock.calls) {
      expect(Object.keys(args.data)).toEqual(['refundSettledAt']);
    }
  });

  it('refuses an order that never took money', async () => {
    const { service, tx } = build({ received: 0 });

    expect(await conflictCode(service.record('ord_1', dto()))).toBe(
      'REFUND_NOTHING_RECEIVED',
    );
    expect(tx.financialRefund.create).not.toHaveBeenCalled();
  });

  it('refuses more than can still go back', async () => {
    const { service, tx } = build({ received: 100, refunded: 60 });

    expect(
      await conflictCode(service.record('ord_1', dto({ amountUzs: 41 }))),
    ).toBe('REFUND_EXCEEDS_RECEIVED');
    expect(tx.financialRefund.create).not.toHaveBeenCalled();
  });

  it('takes exactly what is left', async () => {
    const { service, tx } = build({ received: 100, refunded: 60 });

    await service.record('ord_1', dto({ amountUzs: 40 }));

    expect(tx.financialRefund.create).toHaveBeenCalled();
  });

  it('a second entry with the same document is a repeat, not a second refund', async () => {
    const { service, tx } = build({ received: 100, duplicate: true });

    expect(await conflictCode(service.record('ord_1', dto()))).toBe(
      'REFUND_DUPLICATE_REFERENCE',
    );
    expect(tx.financialRefund.create).not.toHaveBeenCalled();
  });

  it('a provider refund needs a provider payment', async () => {
    const { service, tx } = build({ received: 0 });
    tx.orderStatusHistory.count.mockResolvedValue(1);
    tx.order.findUnique.mockResolvedValue({ totalUzs: 100 });

    expect(await conflictCode(service.record('ord_1', dto()))).toBe(
      'REFUND_NO_PROVIDER_PAYMENT',
    );

    await service.record(
      'ord_1',
      dto({ method: RefundMethod.CASH, reference: 'RKO-7' }),
    );
    expect(tx.financialRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentId: null, method: 'CASH' }),
      }),
    );
  });

  it('refuses a date in the future', async () => {
    const { service } = build({ received: 100 });

    await expect(
      service.record('ord_1', dto({ refundedAt: '2999-01-01' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on an unknown order', async () => {
    const { service } = build({ orderExists: false });

    await expect(service.record('nope', dto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AdminRefundsService.voidEntry', () => {
  it('keeps the entry, marks who and why, and leaves an audit entry', async () => {
    const { service, tx, audit } = build({ received: 100 });

    await service.voidEntry('rfd_1', { reason: 'Typo' }, { actor: ACTOR });

    expect(tx.financialRefund.delete).not.toHaveBeenCalled();
    expect(tx.financialRefund.update).toHaveBeenCalledWith({
      where: { id: 'rfd_1' },
      data: expect.objectContaining({
        voidedById: ACTOR.id,
        voidedByEmail: ACTOR.email,
        voidReason: 'Typo',
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AdminAuditAction.REFUND_VOIDED,
        reason: 'Typo',
      }),
      tx,
    );
  });

  it('puts the amount owed back: the order is no longer settled', async () => {
    const { service, tx } = build({ received: 100 });

    await service.voidEntry('rfd_1', { reason: 'Typo' });

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord_1', refundSettledAt: { not: null } },
      data: { refundSettledAt: null },
    });
  });

  it('cannot void what the provider confirmed', async () => {
    const { service, tx } = build({
      received: 100,
      entry: { providerConfirmedAt: new Date() },
    });

    expect(
      await conflictCode(service.voidEntry('rfd_1', { reason: 'x' })),
    ).toBe('REFUND_CONFIRMED_BY_PROVIDER');
    expect(tx.financialRefund.update).not.toHaveBeenCalled();
  });

  it('a repeat is refused rather than voiding twice', async () => {
    const { service, tx } = build({
      received: 100,
      entry: { voidedAt: new Date() },
    });

    expect(
      await conflictCode(service.voidEntry('rfd_1', { reason: 'x' })),
    ).toBe('REFUND_ALREADY_VOIDED');
    expect(tx.financialRefund.update).not.toHaveBeenCalled();
  });

  it('404s on an unknown entry', async () => {
    const { service } = build({ entry: null });

    await expect(
      service.voidEntry('nope', { reason: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest matchers are typed `any` */
describe('AdminRefundsService.record — the service fee', () => {
  // The brief's order: 600 000 of parts, a 20 000 fee, 25 000 of delivery.
  const PAID = { received: 645_000, fee: 20_000 };

  it('a partial refund of goods leaves the fee with Mator, unless it says otherwise', async () => {
    const { service, tx } = build(PAID);

    await service.record('ord_1', dto({ amountUzs: 100_000 }));

    expect(tx.financialRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amountUzs: new Prisma.Decimal(100_000),
          serviceFeeUzs: new Prisma.Decimal(0),
        }),
      }),
    );
  });

  it('records the share of the fee a refund gives back, in the entry and its audit', async () => {
    const { service, tx, audit } = build(PAID);

    await service.record(
      'ord_1',
      dto({ amountUzs: 120_000, serviceFeeUzs: 20_000 }),
    );

    expect(tx.financialRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          serviceFeeUzs: new Prisma.Decimal(20_000),
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        newValues: expect.objectContaining({ serviceFeeUzs: '20000.00' }),
      }),
      tx,
    );
  });

  it('a refund of all that is left gives back every part of it, fee included, unasked', async () => {
    const { service, tx } = build(PAID);

    await service.record('ord_1', dto({ amountUzs: 645_000 }));

    expect(tx.financialRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amountUzs: new Prisma.Decimal(645_000),
          serviceFeeUzs: new Prisma.Decimal(20_000),
        }),
      }),
    );
  });

  it('a breakdown stated for a refund of everything has to agree with it', async () => {
    const { service, tx } = build(PAID);

    expect(
      await conflictCode(
        service.record(
          'ord_1',
          dto({ amountUzs: 645_000, serviceFeeUzs: 5_000 }),
        ),
      ),
    ).toBe('REFUND_BREAKDOWN_MISMATCH');
    expect(tx.financialRefund.create).not.toHaveBeenCalled();
  });

  it('a partial refund reaching into the fee has to say so', async () => {
    const { service, tx } = build(PAID);

    // 630 000 is more than the 625 000 the goods hold.
    expect(
      await conflictCode(service.record('ord_1', dto({ amountUzs: 630_000 }))),
    ).toBe('REFUND_BREAKDOWN_REQUIRED');
    expect(tx.financialRefund.create).not.toHaveBeenCalled();

    await service.record(
      'ord_1',
      dto({ amountUzs: 630_000, serviceFeeUzs: 5_000 }),
    );
    expect(tx.financialRefund.create).toHaveBeenCalled();
  });

  it.each([
    [
      'more of the fee than the refund',
      { amountUzs: 10_000, serviceFeeUzs: 15_000 },
    ],
    [
      'more of the fee than the order holds',
      { amountUzs: 100_000, serviceFeeUzs: 25_000 },
    ],
  ])('refuses %s', async (_, over) => {
    const { service, tx } = build(PAID);

    expect(await conflictCode(service.record('ord_1', dto(over)))).toBe(
      'REFUND_FEE_EXCEEDS_CHARGED',
    );
    expect(tx.financialRefund.create).not.toHaveBeenCalled();
  });

  it('a fee given back once cannot be given back again', async () => {
    const { service } = build({
      ...PAID,
      refunded: 20_000,
      feeRefunded: 20_000,
    });

    expect(
      await conflictCode(
        service.record(
          'ord_1',
          dto({ amountUzs: 5_000, serviceFeeUzs: 5_000 }),
        ),
      ),
    ).toBe('REFUND_FEE_EXCEEDS_CHARGED');
  });

  it('shows where the fee stands, with the order’s other figures', async () => {
    const { service, tx } = build({ ...PAID, refunded: 100_000 });
    // The listing reads full rows; the position reads amounts only.
    tx.financialRefund.findMany.mockImplementation(
      ({ select }: { select: Record<string, unknown> }) =>
        Promise.resolve(
          'order' in select ? [] : [{ amountUzs: 100_000, serviceFeeUzs: 0 }],
        ),
    );

    const res = await service.forOrder('ord_1');

    expect(res.data).toMatchObject({
      received: 645_000,
      refunded: 100_000,
      remaining: 545_000,
      serviceFee: { charged: 20_000, refunded: 0, retained: 20_000 },
    });
  });
});

describe('AdminRefundsService — refunds outside Payme have no confirmed return receipt', () => {
  const PAID_100 = { received: 100 };

  it('a cash refund with no receipt recorded raises an alert once written', async () => {
    const { service, alerts } = build({
      ...PAID_100,
      written: { method: RefundMethod.CASH, reference: 'KO-1' },
    });

    const res = await service.record(
      'ord_1',
      dto({ method: RefundMethod.CASH, reference: 'KO-1' }),
    );

    expect(res.data.fiscalReceipt).toEqual({
      status: 'missing',
      receiptId: null,
    });
    expect(alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'refund_receipt_unconfirmed',
        severity: 'warning',
        context: {
          refundId: 'rfd_1',
          orderId: 'ord_1',
          method: 'cash',
          fiscalStatus: 'missing',
        },
      }),
    );
  });

  it('a receipt number an operator states is not a confirmation either', async () => {
    const { service, tx, alerts } = build({
      ...PAID_100,
      written: {
        method: RefundMethod.TERMINAL,
        reference: 'T-9',
        fiscalReference: 'OFD-555',
      },
    });

    const res = await service.record(
      'ord_1',
      dto({
        method: RefundMethod.TERMINAL,
        reference: 'T-9',
        fiscalReference: 'OFD-555',
      }),
    );

    expect(tx.financialRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fiscalReference: 'OFD-555' }),
      }),
    );
    expect(res.data.fiscalReceipt.status).toBe('stated_by_operator');
    expect(alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          fiscalStatus: 'stated_by_operator',
        }),
      }),
    );
  });

  it('a refund through Payme raises none: Payme reports its own cancellation receipt', async () => {
    const { service, alerts } = build(PAID_100);

    await service.record('ord_1', dto());

    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('nothing is raised for a refund that was refused', async () => {
    const { service, alerts } = build({ received: 50 });

    await service
      .record('ord_1', dto({ method: RefundMethod.CASH }))
      .catch(() => undefined);

    expect(alerts.raise).not.toHaveBeenCalled();
  });
});

describe('AdminRefundsService.forOrder — whose goods can go back', () => {
  it('names each seller beside their goods', async () => {
    const { service, tx } = build({ received: 300_000 });
    tx.order.findUnique.mockResolvedValue({
      totalUzs: 300_000,
      serviceFeeUzs: 0,
      deliveryUzs: 0,
      items: [
        { sellerId: 'dealer_a', lineTotalUzs: 200_000 },
        { sellerId: 'dealer_b', lineTotalUzs: 100_000 },
      ],
    });
    tx.catalogSeller.findMany.mockResolvedValue([
      { id: 'dealer_a', name: 'Driver’s Village' },
    ]);

    const res = await service.forOrder('ord_1');

    expect(res.data.sellers).toEqual([
      {
        sellerId: 'dealer_a',
        name: 'Driver’s Village',
        charged: 200_000,
        refunded: 0,
        remaining: 200_000,
      },
      {
        sellerId: 'dealer_b',
        name: null,
        charged: 100_000,
        refunded: 0,
        remaining: 100_000,
      },
    ]);
  });
});
/* eslint-enable @typescript-eslint/no-unsafe-assignment */
