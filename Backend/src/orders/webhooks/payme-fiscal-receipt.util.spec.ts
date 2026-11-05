import {
  FiscalReceiptCallback,
  parseSetFiscalData,
} from './payme-fiscal-receipt.util';

/** Payme's own sample, from its SetFiscalData documentation. */
const SAMPLE = {
  receipt_id: 121,
  status_code: 0,
  message: 'accepted',
  terminal_id: 'EP000000000025',
  fiscal_sign: '800031554082',
  qr_code_url: 'fiscal receipt url',
  date: '20220706221021',
};
const params = (data: unknown = SAMPLE, type: unknown = 'PERFORM') => ({
  id: '61396aaed8b87a4c215ae556',
  type,
  fiscal_data: data,
});
const parsed = (raw: unknown): FiscalReceiptCallback => {
  const result = parseSetFiscalData(raw);
  if (!result.ok) throw new Error(`refused: ${result.invalid}`);
  return result.callback;
};

describe('parseSetFiscalData', () => {
  it('reads Payme’s documented sample', () => {
    expect(parsed(params())).toEqual({
      transactionId: '61396aaed8b87a4c215ae556',
      type: 'PERFORM',
      receiptId: '121',
      statusCode: 0,
      message: 'accepted',
      terminalId: 'EP000000000025',
      fiscalSign: '800031554082',
      qrCodeUrl: 'fiscal receipt url',
      fiscalDate: '20220706221021',
      raw: SAMPLE,
    });
  });

  it('reads a cancellation', () => {
    expect(parsed(params(SAMPLE, 'CANCEL')).type).toBe('CANCEL');
  });

  it('takes receipt_id as the String its table says, or the number its sample sends', () => {
    expect(parsed(params({ ...SAMPLE, receipt_id: '121' })).receiptId).toBe(
      '121',
    );
    expect(parsed(params({ ...SAMPLE, receipt_id: 121 })).receiptId).toBe('121');
    expect(parsed(params({ ...SAMPLE, receipt_id: 0 })).receiptId).toBe('0');
  });

  it('keeps what a failed registration sends, with no fiscal sign to its name', () => {
    const callback = parsed(
      params({ receipt_id: 7, status_code: 9, message: 'OFD is down' }),
    );
    expect(callback).toMatchObject({
      statusCode: 9,
      message: 'OFD is down',
      fiscalSign: null,
      qrCodeUrl: null,
      fiscalDate: null,
      terminalId: null,
    });
  });

  it('reads a blank or null field as absent', () => {
    expect(
      parsed(params({ ...SAMPLE, qr_code_url: '', fiscal_sign: null })),
    ).toMatchObject({ qrCodeUrl: null, fiscalSign: null });
  });

  it('takes a status with no receipt id, and a receipt id with no status', () => {
    expect(parsed(params({ status_code: 5 })).statusCode).toBe(5);
    expect(parsed(params({ receipt_id: 5 })).statusCode).toBeNull();
  });

  it('keeps a field it does not know, in the raw copy', () => {
    const data = { ...SAMPLE, something_new: { a: 1 } };
    expect(parsed(params(data)).raw).toEqual(data);
  });

  it.each<[string, unknown, string]>([
    ['params that are no object', 'nope', 'params'],
    ['params that are an array', [], 'params'],
    ['null params', null, 'params'],
    ['no id', { type: 'PERFORM', fiscal_data: SAMPLE }, 'id'],
    ['a blank id', { id: '  ', type: 'PERFORM', fiscal_data: SAMPLE }, 'id'],
    ['a numeric id', { id: 12, type: 'PERFORM', fiscal_data: SAMPLE }, 'id'],
    ['no type', { id: 'x', fiscal_data: SAMPLE }, 'type'],
    ['an unknown type', params(SAMPLE, 'REFUND'), 'type'],
    ['a lower-case type', params(SAMPLE, 'perform'), 'type'],
    ['no fiscal_data', { id: 'x', type: 'PERFORM' }, 'fiscal_data'],
    ['fiscal_data that is an array', params([]), 'fiscal_data'],
    ['fiscal_data that says nothing', params({}), 'fiscal_data'],
    [
      'a status code that is text',
      params({ ...SAMPLE, status_code: '0' }),
      'fiscal_data.status_code',
    ],
    [
      'a fractional status code',
      params({ ...SAMPLE, status_code: 0.5 }),
      'fiscal_data.status_code',
    ],
    [
      'an object for a receipt id',
      params({ ...SAMPLE, receipt_id: {} }),
      'fiscal_data.receipt_id',
    ],
    [
      'a receipt id past the safe integers, whose digits JSON has already lost',
      params({ ...SAMPLE, receipt_id: 2 ** 60 }),
      'fiscal_data.receipt_id',
    ],
    [
      'a message that is no text',
      params({ ...SAMPLE, message: { ru: 'x' } }),
      'fiscal_data.message',
    ],
    [
      'a url that is no text',
      params({ ...SAMPLE, qr_code_url: 1 }),
      'fiscal_data.qr_code_url',
    ],
  ])('refuses %s, naming it', (_, raw, invalid) => {
    expect(parseSetFiscalData(raw)).toEqual({ ok: false, invalid });
  });
});
