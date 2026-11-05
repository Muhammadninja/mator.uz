/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Recording fiscal receipts over an in-memory table that honours the (payment, type)
 * key. It says nothing about PostgreSQL. The concurrent case is staged by forcing the
 * unique violation a real insert would raise.
 */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, PrismaMock } from '../../../test/utils/harness';
import { PaymeFiscalReceiptService } from './payme-fiscal-receipt.service';
import {
  FiscalReceiptCallback,
  parseSetFiscalData,
} from './payme-fiscal-receipt.util';

const DATA = {
  receipt_id: 121,
  status_code: 0,
  message: 'accepted',
  terminal_id: 'EP000000000025',
  fiscal_sign: '800031554082',
  qr_code_url: 'https://ofd.soliq.uz/check?t=1',
  date: '20220706221021',
};
const callback = (
  data: object = DATA,
  type: 'PERFORM' | 'CANCEL' = 'PERFORM',
): FiscalReceiptCallback => {
  const parsed = parseSetFiscalData({ id: 'pmt-1', type, fiscal_data: data });
  if (!parsed.ok) throw new Error(parsed.invalid);
  return parsed.callback;
};
const P2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('PaymeFiscalReceiptService', () => {
  let prisma: PrismaMock;
  let service: PaymeFiscalReceiptService;
  let table: Map<string, any>;
  const key = (k: { paymentId: string; type: string }) =>
    `${k.paymentId}:${k.type}`;
  const stored = (type = 'PERFORM') => table.get(`pay_1:${type}`);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    table = new Map();
    prisma = createPrismaMock();
    prisma.payment.findUnique.mockResolvedValue({
      id: 'pay_1',
      providerState: 2,
    });
    const find = ({ where }: any) =>
      Promise.resolve(table.get(key(where.paymentId_type)) ?? null);
    prisma.paymeFiscalReceipt.findUnique.mockImplementation(find);
    prisma.paymeFiscalReceipt.findUniqueOrThrow.mockImplementation(find);
    prisma.paymeFiscalReceipt.create.mockImplementation(({ data }: any) => {
      if (table.has(key(data))) return Promise.reject(P2002());
      const row = { conflictCount: 0, lastConflictData: null, ...data };
      table.set(key(data), row);
      return Promise.resolve(row);
    });
    prisma.paymeFiscalReceipt.updateMany.mockImplementation(
      ({ where, data }: any) => {
        const row = table.get(key(where));
        const notAccepted = where.OR.some(
          (or: any) =>
            (or.statusCode === null && row?.statusCode === null) ||
            (or.statusCode?.not !== undefined &&
              row?.statusCode !== null &&
              row?.statusCode !== or.statusCode.not),
        );
        if (!row || !notAccepted) return Promise.resolve({ count: 0 });
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      },
    );
    prisma.paymeFiscalReceipt.update.mockImplementation(
      ({ where, data }: any) => {
        const row = table.get(key(where.paymentId_type));
        Object.assign(row, data, {
          conflictCount: row.conflictCount + data.conflictCount.increment,
        });
        return Promise.resolve(row);
      },
    );
    service = new PaymeFiscalReceiptService(prisma as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records every field, under the payment the transaction id names', async () => {
    expect(await service.record(callback())).toBe('recorded');

    expect(prisma.payment.findUnique.mock.calls[0][0].where).toEqual({
      provider_providerTransactionId: {
        provider: 'PAYME',
        providerTransactionId: 'pmt-1',
      },
    });
    expect(stored()).toMatchObject({
      paymentId: 'pay_1',
      type: 'PERFORM',
      receiptId: '121',
      statusCode: 0,
      message: 'accepted',
      terminalId: 'EP000000000025',
      fiscalSign: '800031554082',
      qrCodeUrl: 'https://ofd.soliq.uz/check?t=1',
      fiscalDate: '20220706221021',
      rawData: DATA,
    });
  });

  it('says so for a transaction we do not know, and writes nothing', async () => {
    prisma.payment.findUnique.mockResolvedValue(null);
    expect(await service.record(callback())).toBe('not_found');
    expect(table.size).toBe(0);
  });

  it('keeps a sale and its cancellation as two receipts, in either order', async () => {
    const cancel = callback(
      { ...DATA, receipt_id: 123, fiscal_sign: '900031555055' },
      'CANCEL',
    );
    prisma.payment.findUnique.mockResolvedValue({
      id: 'pay_1',
      providerState: -2,
    });

    expect(await service.record(cancel)).toBe('recorded');
    expect(await service.record(callback())).toBe('recorded');

    expect(table.size).toBe(2);
    expect(stored('PERFORM').fiscalSign).toBe('800031554082');
    expect(stored('CANCEL').fiscalSign).toBe('900031555055');
  });

  describe('a repeated callback', () => {
    it('changes nothing, and is success', async () => {
      await service.record(callback());
      const before = { ...stored() };

      expect(await service.record(callback())).toBe('repeat');

      expect(stored()).toEqual(before);
      expect(prisma.paymeFiscalReceipt.create).toHaveBeenCalledTimes(1);
      expect(prisma.paymeFiscalReceipt.updateMany).not.toHaveBeenCalled();
      expect(prisma.paymeFiscalReceipt.update).not.toHaveBeenCalled();
    });

    it('does not depend on how the id was typed', async () => {
      await service.record(callback());
      expect(await service.record(callback({ ...DATA, receipt_id: '121' }))).toBe(
        'repeat',
      );
    });

    it('losing a race to its own copy is a repeat, not an error', async () => {
      await service.record(callback());
      // Both read nothing, then both insert: this one hits the unique key.
      prisma.paymeFiscalReceipt.findUnique.mockResolvedValueOnce(null);

      expect(await service.record(callback())).toBe('repeat');
      expect(table.size).toBe(1);
    });

    it('losing that race to a different receipt is a conflict, not lost', async () => {
      await service.record(callback());
      prisma.paymeFiscalReceipt.findUnique.mockResolvedValueOnce(null);
      const other = { ...DATA, fiscal_sign: 'other' };

      expect(await service.record(callback(other))).toBe('conflict');
      expect(stored().fiscalSign).toBe('800031554082');
      expect(stored().lastConflictData).toEqual(other);
    });

    it('anything else the database says is not swallowed', async () => {
      prisma.paymeFiscalReceipt.create.mockRejectedValue(new Error('db down'));
      await expect(service.record(callback())).rejects.toThrow('db down');
    });
  });

  describe('an accepted receipt', () => {
    it.each([
      ['a different fiscal sign', { ...DATA, fiscal_sign: 'other' }],
      ['a different status', { ...DATA, status_code: 5 }],
      ['a different date', { ...DATA, date: '20991231235959' }],
      ['a different url', { ...DATA, qr_code_url: 'https://evil.example/' }],
    ])('is not overwritten by %s, which is kept beside it', async (_, later) => {
      await service.record(callback());

      expect(await service.record(callback(later))).toBe('conflict');

      expect(stored()).toMatchObject({
        fiscalSign: DATA.fiscal_sign,
        statusCode: 0,
        fiscalDate: DATA.date,
        qrCodeUrl: DATA.qr_code_url,
        rawData: DATA,
        conflictCount: 1,
        lastConflictData: later,
      });
      expect(stored().lastConflictAt).toBeInstanceOf(Date);
    });

    it('counts every conflict, and keeps the latest', async () => {
      await service.record(callback());
      await service.record(callback({ ...DATA, fiscal_sign: 'a' }));
      await service.record(callback({ ...DATA, fiscal_sign: 'b' }));

      expect(stored().conflictCount).toBe(2);
      expect(stored().lastConflictData.fiscal_sign).toBe('b');
      expect(stored().fiscalSign).toBe(DATA.fiscal_sign);
    });
  });

  describe('a receipt not accepted so far', () => {
    const failed = { receipt_id: 121, status_code: 9, message: 'OFD is down' };

    it('takes the acceptance that follows', async () => {
      await service.record(callback(failed));

      expect(await service.record(callback())).toBe('replaced');

      expect(stored()).toMatchObject({
        statusCode: 0,
        fiscalSign: DATA.fiscal_sign,
        rawData: DATA,
        conflictCount: 0,
      });
    });

    it('takes a later failure too, and the same one is a repeat', async () => {
      await service.record(callback(failed));
      expect(await service.record(callback(failed))).toBe('repeat');

      const later = { ...failed, status_code: 10 };
      expect(await service.record(callback(later))).toBe('replaced');
      expect(stored().statusCode).toBe(10);
    });

    it('stays replaceable when it came with no status at all', async () => {
      await service.record(callback({ receipt_id: 121 }));
      expect(stored().statusCode).toBeNull();

      expect(await service.record(callback())).toBe('replaced');
      expect(stored().statusCode).toBe(0);
    });

    it('never overwrites an acceptance that landed a moment ago', async () => {
      await service.record(callback(failed));
      // What this call read says "failed"; by the write it is already accepted.
      const staleRead = { ...stored() };
      Object.assign(stored(), { statusCode: 0, fiscalSign: DATA.fiscal_sign });
      prisma.paymeFiscalReceipt.findUnique.mockResolvedValueOnce(staleRead);

      const outcome = await service.record(
        callback({ ...failed, status_code: 10 }),
      );

      expect(outcome).toBe('conflict');
      expect(stored().statusCode).toBe(0);
    });

    it('writes the conditional that keeps an acceptance safe', async () => {
      await service.record(callback(failed));
      await service.record(callback());

      expect(prisma.paymeFiscalReceipt.updateMany.mock.calls[0][0].where).toEqual(
        {
          paymentId: 'pay_1',
          type: 'PERFORM',
          OR: [{ statusCode: null }, { statusCode: { not: 0 } }],
        },
      );
    });
  });

  describe('a receipt the payment’s state does not explain', () => {
    it.each<[string, number | null, 'PERFORM' | 'CANCEL']>([
      ['a sale on a transaction not performed', 1, 'PERFORM'],
      ['a sale on one cancelled unperformed', -1, 'PERFORM'],
      ['a cancellation on one still performed', 2, 'CANCEL'],
    ])('is still recorded, and flagged: %s', async (_, providerState, type) => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay_1',
        providerState,
      });

      expect(await service.record(callback(DATA, type))).toBe('recorded');

      expect(stored(type)).toBeDefined();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining(`in state ${providerState}`),
      );
    });

    it('a sale after a refund is ordinary, because the two can arrive out of order', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay_1',
        providerState: -2,
      });
      await service.record(callback());
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });
  });

  it('flags a status other than accepted for an operator', async () => {
    await service.record(
      callback({ receipt_id: 1, status_code: 9, message: 'OFD is down' }),
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('status 9'),
    );
  });
});
