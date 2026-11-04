/**
 * The two source formats — 1C's ";" export (numbers "1,234.56") and Excel's
 * tab-delimited text (numbers "1 234,56") — and the per-row source checks
 * that guard the part number: placeholders, shifted columns, units.
 */
import { normalizeSourcePrice, parseDecimal } from './drivers-village-price';
import { mapHeaders, parseRow } from './drivers-village-row.parser';
import { detectDelimiter, parseDelimited } from './tsv-reader';

const REQUIRED = [
  'code_1c',
  'name',
  'unit',
  'price',
  'vehicle_make',
  'vehicle_model',
];
const isHeader = (cells: string[]) => mapHeaders(cells).errors.length === 0;

describe('delimiter — decided by the header row', () => {
  it('reads 1C’s ";" export and Excel’s tab text', () => {
    expect(detectDelimiter(`${REQUIRED.join(';')}\r\na;b`, isHeader)).toEqual({
      ok: true,
      name: 'semicolon',
      delimiter: ';',
    });
    expect(detectDelimiter(`${REQUIRED.join('\t')}\ra\tb`, isHeader)).toEqual({
      ok: true,
      name: 'tab',
      delimiter: '\t',
    });
  });

  it('a ";" inside a tab header does not confuse it — only one split yields the columns', () => {
    const header = [...REQUIRED, 'note; with semicolon'].join('\t');
    expect(detectDelimiter(header, isHeader)).toMatchObject({ name: 'tab' });
  });

  it('refuses a header that works both ways, and one with no delimiter at all', () => {
    // Split by ";": the six columns + one junk cell; split by tabs: one junk
    // cell + the six columns. Either reading is "valid" — so neither is safe.
    const both = `${REQUIRED.join(';')};x\t${REQUIRED.join('\t')}`;
    const ambiguous = detectDelimiter(both, isHeader);
    expect(ambiguous.ok).toBe(false);
    expect(!ambiguous.ok && ambiguous.reason).toMatch(/ambiguous/);
    expect(detectDelimiter('code_1c,name,price', isHeader)).toMatchObject({
      ok: false,
    });
  });

  it('a header with one delimiter but missing columns keeps it, so the header check names them', () => {
    const header = 'code_1c;name;unit;vehicle_make;vehicle_model';
    expect(detectDelimiter(header, isHeader)).toMatchObject({
      ok: true,
      name: 'semicolon',
    });
    expect(mapHeaders(header.split(';')).errors).toEqual([
      'Missing required column: price',
    ]);
  });

  it('parses ";" records with quoted fields and literal quotes inside names', () => {
    expect(
      parseDelimited('a;"b; c";Масло "Mobil" 1 л\r\n﻿', ';').map(
        (r) => r.cells,
      ),
    ).toEqual([['a', 'b; c', 'Масло "Mobil" 1 л']]);
  });
});

describe('numbers — read in the export’s format, never guessed', () => {
  const price = (raw: string, format: 'thousands-comma' | 'decimal-comma') =>
    normalizeSourcePrice(raw, format);

  it.each([
    ['1,100,000', '1100000.00', false],
    ['1,234,567', '1234567.00', false],
    ['123,456', '123456.00', false],
    ['12,345', '12345.00', false],
    ['1,234', '1234.00', false],
    ['1,234.56', '1234.56', false],
    ['140', '140000.00', true],
    ['123.45', '123450.00', true],
  ])('";" export price %s → %s UZS', (raw, priceUzs, scaled) => {
    expect(price(raw, 'thousands-comma')).toEqual({
      ok: true,
      priceUzs,
      scaled,
    });
  });

  it.each([
    '12,34',
    '1,5',
    '1.100.000',
    '1 100 000',
    '0,123',
    '1,2345',
    '1234,567',
    '-1,000',
    '0',
    '',
  ])('";" export price %p is rejected, not read as something else', (raw) => {
    expect(price(raw, 'thousands-comma').ok).toBe(false);
  });

  it.each([
    ['2,268', '2268'],
    ['1,234', '1234'],
    ['12.5', '12.5'],
    ['1,234.5', '1234.5'],
    ['0', '0'],
  ])('";" export quantity %s → %s', (raw, expected) => {
    const r = parseDecimal(raw, 3, 'thousands-comma');
    expect(r.ok && r.value.toString()).toBe(expected);
  });

  it('the same cell reads one way per format: a thousands comma is not a decimal comma', () => {
    const qty = (raw: string, f: 'thousands-comma' | 'decimal-comma') => {
      const r = parseDecimal(raw, 3, f);
      return r.ok ? r.value.toString() : 'rejected';
    };
    expect(qty('2,268', 'thousands-comma')).toBe('2268');
    expect(qty('2,268', 'decimal-comma')).toBe('2.268');
    expect(price('1,100,000', 'decimal-comma').ok).toBe(false);
    expect(price('1 100 000', 'decimal-comma')).toMatchObject({
      priceUzs: '1100000.00',
    });
  });
});

describe('row checks that guard the source', () => {
  const header = [...REQUIRED, 'quantity'];
  const headers = mapHeaders(header);
  const row = (cells: Partial<Record<string, string>>, extra: string[] = []) =>
    parseRow(
      [
        ...header.map(
          (h) =>
            ({
              code_1c: '96273708',
              name: 'Фильтр масляный',
              unit: 'шт.',
              price: '123,456',
              vehicle_make: 'CHEVROLET',
              vehicle_model: 'COBALT',
              quantity: '2,268',
              ...cells,
            })[h] ?? '',
        ),
        ...extra,
      ],
      2,
      headers,
      'thousands-comma',
    );
  const errors = (r: ReturnType<typeof row>) =>
    r.issues.filter((i) => i.severity === 'error').map((i) => i.code);

  it('reads the ";" export’s price and quantity', () => {
    expect(row({}).row).toMatchObject({
      priceUzs: '123456.00',
      quantity: 2268,
    });
  });

  it.each(['1', 'B', '0000', '3333', '222222', '1111111'])(
    'code_1c %p — one character repeated — is a placeholder, not a part number',
    (code) => {
      const r = row({ code_1c: code });
      expect(r.row).toBeNull();
      expect(errors(r)).toEqual(['placeholder_code_1c']);
    },
  );

  it.each([
    '96273708',
    '000342222',
    '4607012345678',
    '294',
    '7070',
    '_00-00001431',
    '_БП-01068170',
    '5Q0-615-301-F',
  ])('numeric and 1C-style codes stay valid: %p', (code) => {
    expect(row({ code_1c: code }).row?.code1c).toBe(code);
  });

  it('a value with an unquoted delimiter shifts the columns: the row is rejected, nothing of it is read', () => {
    const r = row({}, ['1,500']);
    expect(r.row).toBeNull();
    expect(errors(r)).toEqual(['column_shift']);
    // Trailing empty cells are not a shift.
    expect(row({}, ['', ' ']).row).not.toBeNull();
  });

  it('units: "штук" is pieces; "1" and "комп." stay unknown', () => {
    expect(row({ unit: 'штук' }).row?.unit).toBe('PCS');
    expect(errors(row({ unit: '1' }))).toEqual(['unknown_unit']);
    expect(errors(row({ unit: 'комп.' }))).toEqual(['unknown_unit']);
  });

  it('fractional and negative quantities are rejected, never rounded or read as thousands', () => {
    expect(errors(row({ quantity: '12.5' }))).toEqual(['invalid_quantity']);
    expect(errors(row({ quantity: '1,234.5' }))).toEqual(['invalid_quantity']);
    expect(errors(row({ quantity: '-3' }))).toEqual(['invalid_quantity']);
    expect(errors(row({ quantity: '2,26' }))).toEqual(['invalid_quantity']);
  });
});
