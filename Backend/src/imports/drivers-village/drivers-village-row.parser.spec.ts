import { parseDecimal } from './drivers-village-price';
import { mapHeaders, parseRow } from './drivers-village-row.parser';

const CURRENT = [
  'code_1c',
  'name',
  'manufacturer_part_number',
  'quantity',
  'unit',
  'vehicle_model',
  'price',
  'vehicle_make',
  'category_id',
  'subcategory_id',
];
const TARGET = [
  'code_1c',
  'name',
  'gm_number',
  'oem_numbers',
  'quantity',
  'unit',
  'vehicle_model',
  'price',
  'vehicle_make',
  'category_id',
  'subcategory_id',
];

type Cells = Partial<Record<string, string>>;
const DEFAULTS: Cells = {
  code_1c: '00-00001431',
  name: 'Амортизатор',
  quantity: '8',
  unit: 'шт.',
  vehicle_model: 'DAMAS-2',
  price: '490 000,00',
  vehicle_make: 'CHEVROLET',
  category_id: 'suspension-and-steering',
  subcategory_id: 'shock-absorbers',
};

function parse(over: Cells, headers = CURRENT) {
  const values = { ...DEFAULTS, ...over };
  return parseRow(
    headers.map((h) => values[h] ?? ''),
    2,
    mapHeaders(headers),
  );
}
const codes = (over: Cells, headers = CURRENT) =>
  parse(over, headers).issues.map((i) => i.code);

describe('mapHeaders', () => {
  it('maps the current export; manufacturer_part_number is recognized and never read', () => {
    const m = mapHeaders(CURRENT);
    expect(m.errors).toEqual([]);
    expect(m.notImported).toContain('manufacturer_part_number');
    expect(Object.values(m.source)).not.toContain('manufacturer_part_number');
    expect(m.index.gmNumber).toBeUndefined();
  });

  it('maps the target layout: gm_number is read, oem_numbers is not', () => {
    const m = mapHeaders(TARGET);
    expect(m.errors).toEqual([]);
    expect(m.source.gmNumber).toBe('gm_number');
    expect(m.notImported).toContain('oem_numbers');
  });

  it('rejects a missing required column and two columns feeding one field', () => {
    expect(mapHeaders(CURRENT.filter((h) => h !== 'price')).errors).toEqual([
      'Missing required column: price',
    ]);
    expect(mapHeaders([...CURRENT, 'price']).errors[0]).toMatch(
      /both map to price/,
    );
    // Neither part-number column is read, so carrying both is no conflict.
    expect(mapHeaders([...CURRENT, 'oem_numbers']).errors).toEqual([]);
  });

  it('accepts an export without a quantity column', () => {
    const m = mapHeaders(CURRENT.filter((h) => h !== 'quantity'));
    expect(m.errors).toEqual([]);
    expect(m.index.quantity).toBeUndefined();
  });

  it('category columns are optional, recognized, and never imported', () => {
    expect(mapHeaders(CURRENT)).toMatchObject({
      errors: [],
      notImported: [
        'manufacturer_part_number',
        'category_id',
        'subcategory_id',
      ],
      ignored: [],
    });
    const without = mapHeaders(
      CURRENT.filter((h) => !['category_id', 'subcategory_id'].includes(h)),
    );
    expect(without).toMatchObject({
      errors: [],
      notImported: ['manufacturer_part_number'],
    });
  });
});

describe('parseDecimal (prices / quantities)', () => {
  it.each([
    ['490 000,00', '490000'],
    ['1 060 387,74', '1060387.74'],
    ['950,98', '950.98'],
    ['13 335 610,00', '13335610'],
    ['8', '8'],
    ['2.5', '2.5'],
  ])('%s → %s', (raw, expected) => {
    const r = parseDecimal(raw, 2);
    expect(r.ok && r.value.toString()).toBe(expected);
  });

  it.each(['', 'abc', '-5', '1.234,56', '1,2,3', '12,345', '1e5'])(
    'rejects %p',
    (raw) => {
      expect(parseDecimal(raw, 2).ok).toBe(false);
    },
  );
});

describe('parseRow', () => {
  it('produces a canonical row from the current export', () => {
    const { row, issues } = parse({ manufacturer_part_number: '96611630' });
    expect(issues).toEqual([]);
    expect(row).toMatchObject({
      code1c: '00-00001431',
      priceUzs: '490000.00',
      sourcePrice: '490 000,00',
      priceScaled: false,
      quantity: 8,
      unit: 'PCS',
      sourceUnit: 'шт.',
      gmNumber: null,
      // The part number is code_1c; the manufacturer_part_number cell is ignored.
      sourcePartNumber: '00-00001431',
      oemNumbers: ['0000001431'],
      vehicle: { kind: 'models', make: 'Chevrolet', models: ['Damas'] },
    });
    expect(row).not.toHaveProperty('categoryId');
  });

  it('price: rejects empty, zero, negative and malformed values with the reason', () => {
    for (const price of ['', '0,00', '-55,200', '1,600,000', 'abc', '12,5р'])
      expect(codes({ price })).toEqual(['invalid_price']);
    expect(parse({ price: '-55,200' }).issues[0].message).toBe(
      'price "-55,200": negative',
    );
    expect(parse({ price: '' }).issues[0].message).toBe('price is empty');
  });

  it('price: a value below 1 even in thousands is imported but flagged', () => {
    const r = parse({ price: '0,5' });
    expect(r.row?.priceUzs).toBe('500.00');
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([
      ['price_below_1000_uzs', 'warning'],
    ]);
  });

  it('quantity: whole numbers only, for every unit — a fraction is rejected, never rounded', () => {
    expect(parse({ quantity: '8' }).row?.quantity).toBe(8);
    expect(parse({ quantity: '1 743' }).row?.quantity).toBe(1743);
    expect(parse({ quantity: '0' }).row?.quantity).toBe(0);
    expect(codes({ quantity: '2,5' })).toEqual(['invalid_quantity']);
    expect(codes({ unit: 'л', quantity: '2,5' })).toEqual(['invalid_quantity']);
    expect(codes({ quantity: '-1' })).toEqual(['invalid_quantity']);
  });

  it('quantity: an empty cell or no column at all is "not given" (null), not an error', () => {
    for (const quantity of ['', '   ']) {
      const r = parse({ quantity });
      expect(r.issues).toEqual([]);
      expect(r.row?.quantity).toBeNull();
    }
    const noColumn = parse(
      {},
      CURRENT.filter((h) => h !== 'quantity'),
    );
    expect(noColumn.issues).toEqual([]);
    expect(noColumn.row?.quantity).toBeNull();
  });

  it('unit is kept separately from quantity; unknown units are errors', () => {
    expect(parse({ unit: 'л', quantity: '64' }).row).toMatchObject({
      unit: 'L',
      sourceUnit: 'л',
      quantity: 64,
    });
    expect(parse({ unit: 'литр', quantity: '20' }).row).toMatchObject({
      unit: 'L',
      quantity: 20,
    });
    expect(parse({ unit: 'шт.' }).row).toMatchObject({
      unit: 'PCS',
      sourceUnit: 'шт.',
    });
    expect(codes({ unit: '1' })).toEqual(['unknown_unit']);
  });

  it('price: from 1000 up the source value exactly; below 1000 in thousands (×1000); never rounded', () => {
    expect(parse({ price: '195 642,86' }).row?.priceUzs).toBe('195642.86');
    expect(parse({ price: '490 000,00' }).row?.priceUzs).toBe('490000.00');
    expect(parse({ price: '13 335 610' }).row?.priceUzs).toBe('13335610.00');
    expect(parse({ price: '950,98' }).row).toMatchObject({
      priceUzs: '950980.00',
      sourcePrice: '950,98',
      priceScaled: true,
    });
    // More precision than a UZS amount can hold is rejected, not rounded.
    expect(codes({ price: '195 642,855' })).toEqual(['invalid_price']);
  });

  it('GM: one all-digit value; letters or several values are errors', () => {
    expect(parse({ gm_number: '96611630' }, TARGET).row?.gmNumber).toBe(
      '96611630',
    );
    expect(parse({ gm_number: '' }, TARGET).row?.gmNumber).toBeNull();
    expect(codes({ gm_number: 'S4511006' }, TARGET)).toEqual([
      'invalid_gm_number',
    ]);
    expect(codes({ gm_number: '96611630 96611629' }, TARGET)).toEqual([
      'invalid_gm_number',
    ]);
  });

  it('GM and OEM stay separate — no cross-copying', () => {
    const { row } = parse(
      { gm_number: '96611630', oem_numbers: 'S4511006' },
      TARGET,
    );
    expect(row).toMatchObject({
      gmNumber: '96611630',
      sourcePartNumber: '00-00001431',
      oemNumbers: ['0000001431'],
    });
  });

  it('part number = code_1c verbatim (case, leading zeros, symbols); the OEM index is its normalized form', () => {
    const cases: [string, string[]][] = [
      ['06H-905-110-G', ['06H905110G']],
      ['000342222', ['000342222']],
      ['09052781', ['09052781']],
      ['96273708Heinner', ['96273708HEINNER']],
      ['5TA-827-887C', ['5TA827887C']],
      ['Z0000089.', ['Z0000089']],
      ['S45/100.17', ['S4510017']],
    ];
    for (const [code, index] of cases) {
      const r = parse({ code_1c: code, manufacturer_part_number: 'SKODA' });
      expect(r.issues).toEqual([]);
      expect(r.row).toMatchObject({
        code1c: code,
        sourcePartNumber: code,
        oemNumbers: index,
      });
    }
  });

  it('OEM index: a 16-digit code is flagged as a concatenated pair', () => {
    expect(codes({ code_1c: '9549372195493722' })).toEqual([
      'oem_suspect_concatenated',
    ]);
  });

  it('a code that is no plausible number stays the part number, only outside the OEM index', () => {
    // A Cyrillic look-alike would be silently dropped by normalization and
    // index a different number, so such a code is not indexed at all.
    for (const code of ['_БП-01074259', 'БП-01068170', '13502180А', 'A1']) {
      const r = parse({ code_1c: code });
      expect(r.row).toMatchObject({ sourcePartNumber: code, oemNumbers: [] });
      expect(r.issues.map((i) => [i.code, i.severity, i.field])).toEqual([
        ['oem_not_indexed', 'warning', 'code1c'],
      ]);
    }
  });

  it('the manufacturer_part_number and oem_numbers cells never change the row', () => {
    const base = parse({ manufacturer_part_number: '' });
    for (const cell of ['SKODA', '96611630', 'A'.repeat(300), 'Onix, CADDY'])
      expect(parse({ manufacturer_part_number: cell })).toEqual(base);
    expect(parse({ oem_numbers: 'S4511006' }, TARGET).row?.oemNumbers).toEqual([
      '0000001431',
    ]);
  });

  it('vehicles: one cell lists every fitting model — splits on "," and ";", trims, drops blanks, dedupes', () => {
    expect(parse({ vehicle_model: 'DAMAS-2, LABO' }).row?.vehicle).toEqual({
      kind: 'models',
      make: 'Chevrolet',
      models: ['Damas', 'Labo'],
    });
    expect(
      parse({ vehicle_model: 'LACETTI, NEXIA 3, SPARK, COBALT' }).row?.vehicle,
    ).toEqual({
      kind: 'models',
      make: 'Chevrolet',
      models: ['Lacetti', 'Nexia 3', 'Spark', 'Cobalt'],
    });
    expect(
      parse({ vehicle_model: 'COBALT;NEXIA 3;LACETTI' }).row?.vehicle,
    ).toEqual({
      kind: 'models',
      make: 'Chevrolet',
      models: ['Cobalt', 'Nexia 3', 'Lacetti'],
    });
    // Two generation codes of one model collapse into one link.
    expect(
      parse({ vehicle_model: ' TRACKER, TRACKER-2 ;, tracker ' }).row?.vehicle,
    ).toEqual({ kind: 'models', make: 'Chevrolet', models: ['Tracker'] });
  });

  it('vehicles: make-wide is a valid state; empty cells say nothing — never "universal"', () => {
    expect(
      parse({ vehicle_model: '', vehicle_make: 'SKODA' }).row?.vehicle,
    ).toEqual({ kind: 'make', make: 'Skoda' });
    const empty = parse({ vehicle_model: '', vehicle_make: '' });
    expect(empty.issues).toEqual([]);
    expect(empty.row?.vehicle).toEqual({ kind: 'none' });
  });

  it('vehicles: model without make and unknown make/model are errors — one unknown model rejects the row', () => {
    expect(codes({ vehicle_make: '' })).toEqual([
      'invalid_vehicle_combination',
    ]);
    expect(codes({ vehicle_make: 'COBALT', vehicle_model: 'COBALT' })).toEqual([
      'unknown_vehicle_make',
    ]);
    expect(codes({ vehicle_make: 'SKODA', vehicle_model: 'SKODA' })).toEqual([
      'unknown_vehicle_model',
    ]);
    // Never guessed: Tico is Daewoo's, a bare "NEXIA" names no generation.
    expect(codes({ vehicle_model: 'SPARK, NEXIA' })).toEqual([
      'unknown_vehicle_model',
    ]);
    expect(codes({ vehicle_model: 'TICO' })).toEqual(['unknown_vehicle_model']);
  });

  it('category cells are never read: blank or odd values cannot reject a row', () => {
    for (const cells of [
      { category_id: '', subcategory_id: '' },
      { category_id: 'Шины', subcategory_id: 'not an id' },
    ]) {
      const r = parse(cells);
      expect(r.issues).toEqual([]);
      expect(r.row).not.toBeNull();
    }
  });

  it('code_1c and name: required, trimmed, whitespace-normalized', () => {
    expect(codes({ code_1c: '  ' })).toEqual(['empty_code_1c']);
    // Rejected, never altered into a different number: irregular whitespace
    // (two spaces, a no-break space) is never collapsed into another code.
    for (const code_1c of ['95015324  OEM', '95015324\u00a0OEM'])
      expect(codes({ code_1c })).toEqual(['invalid_code_1c']);
    // Articles of letters, digits, single spaces and hyphens are accepted,
    // verbatim — not only numbers.
    for (const code_1c of [
      'БП 010',
      '96810038S&T',
      '123456789 OEM',
      'SCT SB 061-0868',
    ])
      expect(parse({ code_1c }).row).toMatchObject({
        code1c: code_1c,
        sourcePartNumber: code_1c,
      });
    // An 8-digit article with a marker: kept verbatim, space included, as the
    // part number. The OEM index takes it normalized, like the buyer search's
    // query (the 8-digit key is added in planning).
    for (const [code_1c, index] of [
      ['95015324 OEM', '95015324OEM'],
      ['GMB 96273708', 'GMB96273708'],
    ]) {
      const r = parse({ code_1c });
      expect(r.row).toMatchObject({
        code1c: code_1c,
        sourcePartNumber: code_1c,
        oemNumbers: [index],
      });
      expect(r.issues).toEqual([]);
    }
    // A Cyrillic marker cannot be normalized without losing letters.
    expect(parse({ code_1c: '96273708 ГМБ' }).row?.oemNumbers).toEqual([]);
    expect(
      parse({ code_1c: ' БП-01068170 ', name: ' Колодки   передние\t' }).row,
    ).toMatchObject({
      code1c: 'БП-01068170',
      sourcePartNumber: 'БП-01068170',
      name: 'Колодки передние',
    });
    expect(codes({ name: 'Bтулка переднего рычага' })).toEqual([
      'mixed_script_name',
    ]);
  });

  it('keeps the code_1c on a rejected row for the report', () => {
    const r = parse({ unit: '1' });
    expect(r.row).toBeNull();
    expect(r.code1c).toBe('00-00001431');
    expect(r.issues[0]).toMatchObject({
      kind: 'data',
      severity: 'error',
      line: 2,
      code1c: '00-00001431',
    });
  });
});
