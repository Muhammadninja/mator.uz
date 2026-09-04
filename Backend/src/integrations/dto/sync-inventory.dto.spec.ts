import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { NormalizeSyncBodyPipe } from '../normalize-sync-body.pipe';
import { SyncInventoryDto, SyncMode } from './sync-inventory.dto';

/** Validate a raw body exactly as the handler's pipe chain does. */
function validateBody(body: unknown) {
  const normalized = new NormalizeSyncBodyPipe().transform(body);
  const dto = plainToInstance(SyncInventoryDto, normalized, {
    enableImplicitConversion: false,
  });
  return { dto, errors: validateSync(dto, { whitelist: true }) };
}

const validItem = {
  article: '96943770',
  title: 'Фильтр масляный',
  quantity: 42,
  price: 185000,
};

describe('SyncInventoryDto', () => {
  it('accepts a wrapped payload', () => {
    const { dto, errors } = validateBody({ items: [validItem] });

    expect(errors).toHaveLength(0);
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].article).toBe('96943770');
  });

  it('accepts a BARE ARRAY, as 1C often sends it', () => {
    const { dto, errors } = validateBody([validItem, validItem]);

    expect(errors).toHaveLength(0);
    expect(dto.items).toHaveLength(2);
  });

  it('accepts the oem/name aliases as the same fields', () => {
    const { dto, errors } = validateBody([
      { oem: 'SP-1362', name: 'Свеча зажигания', quantity: 5, price: 30000 },
    ]);

    expect(errors).toHaveLength(0);
    expect(dto.items[0].article).toBe('SP-1362');
    expect(dto.items[0].title).toBe('Свеча зажигания');
  });

  it('coerces numeric strings, including a comma decimal separator', () => {
    const { dto, errors } = validateBody([
      { article: 'A1', title: 'X', quantity: '7', price: '185000,50' },
    ]);

    expect(errors).toHaveLength(0);
    expect(dto.items[0].quantity).toBe(7);
    expect(dto.items[0].price).toBe(185000.5);
  });

  it('trims surrounding whitespace on article and title', () => {
    const { dto } = validateBody([
      { article: '  96943770 ', title: '  Фильтр  ', quantity: 1, price: 1 },
    ]);

    expect(dto.items[0].article).toBe('96943770');
    expect(dto.items[0].title).toBe('Фильтр');
  });

  it('rejects an empty array', () => {
    expect(validateBody([]).errors.length).toBeGreaterThan(0);
    expect(validateBody({ items: [] }).errors.length).toBeGreaterThan(0);
  });

  it('rejects a negative quantity and a negative price', () => {
    expect(
      validateBody([{ ...validItem, quantity: -1 }]).errors.length,
    ).toBeGreaterThan(0);
    expect(
      validateBody([{ ...validItem, price: -0.01 }]).errors.length,
    ).toBeGreaterThan(0);
  });

  it('rejects a non-integer quantity', () => {
    expect(
      validateBody([{ ...validItem, quantity: 1.5 }]).errors.length,
    ).toBeGreaterThan(0);
  });

  it('rejects a non-numeric quantity rather than coercing it to NaN', () => {
    const { dto, errors } = validateBody([{ ...validItem, quantity: 'много' }]);

    expect(errors.length).toBeGreaterThan(0);
    expect(dto.items[0].quantity).not.toBeNaN();
  });

  it('rejects a missing article or title', () => {
    expect(
      validateBody([{ title: 'X', quantity: 1, price: 1 }]).errors.length,
    ).toBeGreaterThan(0);
    expect(
      validateBody([{ article: 'A1', quantity: 1, price: 1 }]).errors.length,
    ).toBeGreaterThan(0);
  });

  it('rejects a doubly-wrapped body, which @ValidateNested alone lets through', () => {
    // `[[{…}]]` — a misconfigured export. Without an explicit object check this
    // validates clean and reaches the service with every field undefined.
    expect(validateBody([[validItem]]).errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-object element', () => {
    expect(validateBody(['hello']).errors.length).toBeGreaterThan(0);
    expect(validateBody([null]).errors.length).toBeGreaterThan(0);
    expect(validateBody([42]).errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-finite quantity', () => {
    expect(
      validateBody([{ ...validItem, quantity: Infinity }]).errors.length,
    ).toBeGreaterThan(0);
  });

  it('accepts the optional unit and warehouse', () => {
    const { dto, errors } = validateBody([
      { ...validItem, unit: 'шт', warehouse: 'SKL-01' },
    ]);

    expect(errors).toHaveLength(0);
    expect(dto.items[0].unit).toBe('шт');
    expect(dto.items[0].warehouse).toBe('SKL-01');
  });

  it('accepts an explicit mode and rejects an unknown one', () => {
    expect(
      validateBody({ items: [validItem], mode: 'full' }).errors,
    ).toHaveLength(0);
    expect(
      validateBody({ items: [validItem], mode: 'partial' }).errors,
    ).toHaveLength(0);
    expect(
      validateBody({ items: [validItem], mode: 'wipe' }).errors.length,
    ).toBeGreaterThan(0);
  });

  it('leaves mode undefined when absent, so the service applies PARTIAL', () => {
    const { dto } = validateBody([validItem]);

    expect(dto.mode).toBeUndefined();
    expect(SyncMode.PARTIAL).toBe('partial');
  });
});

describe('NormalizeSyncBodyPipe', () => {
  const pipe = new NormalizeSyncBodyPipe();

  it('wraps a bare array', () => {
    expect(pipe.transform([{ a: 1 }])).toEqual({ items: [{ a: 1 }] });
  });

  it('leaves an object untouched', () => {
    const body = { items: [], mode: 'full' };
    expect(pipe.transform(body)).toBe(body);
  });

  it('passes a malformed body through so validation reports it', () => {
    expect(pipe.transform('nonsense')).toBe('nonsense');
    expect(pipe.transform(null)).toBeNull();
  });
});
