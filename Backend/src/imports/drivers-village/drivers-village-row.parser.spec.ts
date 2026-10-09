import {
  mapHeaders,
  parseDecimal,
  parseRow,
} from './drivers-village-row.parser';

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
  it('maps the current export, reading manufacturer_part_number as OEM numbers', () => {
    const m = mapHeaders(CURRENT);
    expect(m.errors).toEqual([]);
    expect(m.source.oemNumbers).toBe('manufacturer_part_number');
    expect(m.index.gmNumber).toBeUndefined();
  });

  it('maps the target layout with separate gm_number / oem_numbers columns', () => {
    const m = mapHeaders(TARGET);
    expect(m.errors).toEqual([]);
    expect(m.source).toMatchObject({
      gmNumber: 'gm_number',
      oemNumbers: 'oem_numbers',
    });
  });

  it('rejects a missing required column and two columns feeding one field', () => {
    expect(mapHeaders(CURRENT.filter((h) => h !== 'price')).errors).toEqual([
      'Missing required column: price',
    ]);
    expect(mapHeaders([...CURRENT, 'oem_numbers']).errors[0]).toMatch(
      /both map to oemNumbers/,
    );
  });

  it('accepts an export without a quantity column', () => {
    const m = mapHeaders(CURRENT.filter((h) => h !== 'quantity'));
    expect(m.errors).toEqual([]);
    expect(m.index.quantity).toBeUndefined();
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
      quantity: 8,
      unit: 'PCS',
      sourceUnit: 'шт.',
      gmNumber: null,
      sourcePartNumber: '96611630',
      oemNumbers: ['96611630'],
      vehicle: { kind: 'models', make: 'Chevrolet', models: ['Damas'] },
      categoryId: 'suspension-and-steering',
      subcategoryId: 'shock-absorbers',
    });
  });

  it('price: rejects zero and malformed values', () => {
    expect(codes({ price: '0,00' })).toEqual(['invalid_price']);
    expect(codes({ price: '12,345' })).toEqual(['invalid_price']);
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

  it('price: the source value exactly — no markup, no conversion, no rounding', () => {
    expect(parse({ price: '195 642,86' }).row?.priceUzs).toBe('195642.86');
    expect(parse({ price: '490 000,00' }).row?.priceUzs).toBe('490000.00');
    expect(parse({ price: '950,98' }).row?.priceUzs).toBe('950.98');
    expect(parse({ price: '13 335 610' }).row?.priceUzs).toBe('13335610.00');
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
      oemNumbers: ['S4511006'],
    });
  });

  it('OEM: space-separated, normalized, deduplicated, source order kept', () => {
    expect(
      parse({ manufacturer_part_number: 'ABC123 XYZ456 QWE789' }).row
        ?.oemNumbers,
    ).toEqual(['ABC123', 'XYZ456', 'QWE789']);
    expect(
      parse({ manufacturer_part_number: '25192923 96988257  25192923' }).row
        ?.oemNumbers,
    ).toEqual(['25192923', '96988257']);
    expect(
      parse({ manufacturer_part_number: 's45-100.17 S4510017' }).row
        ?.oemNumbers,
    ).toEqual(['S4510017']);
    expect(parse({ manufacturer_part_number: '' }).row?.oemNumbers).toEqual([]);
  });

  it('OEM index: a comma separator and a concatenated pair are warnings', () => {
    const comma = parse({ manufacturer_part_number: '13271190, 13503675' });
    expect(comma.row?.oemNumbers).toEqual(['13271190', '13503675']);
    expect(comma.issues.map((i) => [i.code, i.severity])).toEqual([
      ['oem_nonstandard_separator', 'warning'],
    ]);
    expect(
      codes({ manufacturer_part_number: '96852631 9549372195493722' }),
    ).toEqual(['oem_suspect_concatenated']);
  });

  it('part number: the cell is kept verbatim; only plausible parts enter the OEM index', () => {
    const cases: [string, string[]][] = [
      ['Solite 57412', ['SOLITE', '57412']],
      ['SCT SB 061-0868', ['SCT', '0610868']],
      // A Cyrillic look-alike would be silently dropped by normalization and
      // index a different number, so the part is not indexed at all.
      ['13502180А', []],
      ['АФГ94582132&94582135&94582157', []],
      [' LADA NIVA', ['LADA', 'NIVA']],
      ['96273708PMC(EU)', []],
      ['12 34', []],
    ];
    for (const [raw, index] of cases) {
      const r = parse({ manufacturer_part_number: raw });
      expect(r.row).toMatchObject({ sourcePartNumber: raw, oemNumbers: index });
      expect(r.issues.every((i) => i.severity === 'warning')).toBe(true);
    }
    expect(codes({ manufacturer_part_number: 'SCT SB 061-0868' })).toEqual([
      'oem_not_indexed',
    ]);
    expect(codes({ manufacturer_part_number: 'С4511006' })).toEqual([
      'oem_not_indexed',
    ]);
  });

  it('part number: blank is null; over the limit is rejected, never cut', () => {
    expect(parse({ manufacturer_part_number: '' }).row?.sourcePartNumber).toBe(
      null,
    );
    expect(
      parse({ manufacturer_part_number: '   ' }).row?.sourcePartNumber,
    ).toBeNull();
    expect(codes({ manufacturer_part_number: 'A'.repeat(256) })).toEqual([
      'part_number_too_long',
      'oem_not_indexed',
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

  it('vehicles: make-wide and global universal are valid states', () => {
    expect(
      parse({ vehicle_model: '', vehicle_make: 'SKODA' }).row?.vehicle,
    ).toEqual({ kind: 'make', make: 'Skoda' });
    const universal = parse({ vehicle_model: '', vehicle_make: '' });
    expect(universal.issues).toEqual([]);
    expect(universal.row?.vehicle).toEqual({ kind: 'universal' });
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

  it('categories are passed through verbatim; only a blank or non-id value is an error', () => {
    expect(
      parse({ category_id: 'engine', subcategory_id: 'fuel-and-oil-pumps' })
        .row,
    ).toMatchObject({
      categoryId: 'engine',
      subcategoryId: 'fuel-and-oil-pumps',
    });
    expect(codes({ subcategory_id: '' })).toEqual(['empty_category']);
    expect(codes({ category_id: 'Шины' })).toEqual(['invalid_category_id']);
  });

  it('code_1c and name: required, trimmed, whitespace-normalized', () => {
    expect(codes({ code_1c: '  ' })).toEqual(['empty_code_1c']);
    expect(codes({ code_1c: 'БП 010' })).toEqual(['invalid_code_1c']);
    expect(
      parse({ code_1c: ' БП-01068170 ', name: ' Колодки   передние\t' }).row,
    ).toMatchObject({ code1c: 'БП-01068170', name: 'Колодки передние' });
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
