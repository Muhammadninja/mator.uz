import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ListRefundsQueryDto,
  RecordRefundDto,
  VoidRefundDto,
} from './record-refund.dto';

const failedFields = (payload: Record<string, unknown>) =>
  validateSync(plainToInstance(RecordRefundDto, payload)).map(
    (e) => e.property,
  );

const valid = {
  amountUzs: 100_000,
  method: 'PROVIDER',
  reference: 'TX-1',
  reason: 'Out of stock',
};

describe('RecordRefundDto', () => {
  it('takes a complete entry', () => {
    expect(failedFields(valid)).toEqual([]);
  });

  it.each([0, -5, 0.001, 1e13, 'lots'])(
    'refuses an amount of %s',
    (amountUzs) => {
      expect(failedFields({ ...valid, amountUzs })).toEqual(['amountUzs']);
    },
  );

  it.each(['', '   '])('requires a document and a reason, not %j', (blank) => {
    expect(failedFields({ ...valid, reference: blank })).toEqual(['reference']);
    expect(failedFields({ ...valid, reason: blank })).toEqual(['reason']);
  });

  it('knows only the methods the registry has', () => {
    expect(failedFields({ ...valid, method: 'CRYPTO' })).toEqual(['method']);
  });

  it('takes a past date, and refuses something that is not one', () => {
    expect(failedFields({ ...valid, refundedAt: '2026-10-30' })).toEqual([]);
    expect(failedFields({ ...valid, refundedAt: 'yesterday' })).toEqual([
      'refundedAt',
    ]);
  });
});

describe('VoidRefundDto', () => {
  it('requires a reason', () => {
    const errors = validateSync(
      plainToInstance(VoidRefundDto, { reason: ' ' }),
    );
    expect(errors.map((e) => e.property)).toEqual(['reason']);
  });
});

describe('ListRefundsQueryDto', () => {
  it('takes known states only', () => {
    const errorsFor = (state: string) =>
      validateSync(plainToInstance(ListRefundsQueryDto, { state }));
    expect(errorsFor('voided')).toEqual([]);
    expect(errorsFor('deleted')).toHaveLength(1);
  });
});
