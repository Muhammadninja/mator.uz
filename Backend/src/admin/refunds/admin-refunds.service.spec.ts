// The rules of the refund registry. What it must never do matters as much as what it
// records: it never touches a status, never lets more go back than came in, and
// keeps a wrong entry on record instead of deleting it.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, RefundMethod } from '@prisma/client';
import { AdminRefundsService } from './admin-refunds.service';
import { RecordRefundDto } from './dto/record-refund.dto';

const ACTOR = { id: 'adm_1', email: 'mgr@mator.test', name: 'Mira' };

function build(state: {
  received?: number;
  refunded?: number;
  duplicate?: boolean;
  orderExists?: boolean;
  entry?: Record<string, unknown> | null;
}) {
  const row = {
    id: 'rfd_1',
    orderId: 'ord_1',
    paymentId: 'pay_1',
    amountUzs: 100,
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
  };
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValue(state.orderExists === false ? [] : [{ id: 'ord_1' }]),
    order: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ totalUzs: state.received ?? 0 }),
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
    financialRefund: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          state.refunded ? [{ amountUzs: state.refunded }] : [],
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
  const service = new AdminRefundsService(prisma as never, audit as never);
  return { service, tx, audit };
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
