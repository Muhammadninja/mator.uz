/**
 * code_1c as the part number, and one position per code_1c at its highest
 * valid price — end to end: the real importer and the REAL Stock →
 * CatalogPart projection over in-memory fakes. No database.
 */
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import {
  driversVillageFixture,
  FakeDb,
  FakeDriversVillageStore,
} from '../../../test/utils/drivers-village-fake-db';
import { fakeCatalogPrisma } from '../../../test/utils/drivers-village-fake-catalog';
import { DriversVillageImportService } from './drivers-village-import.service';

const COLUMNS = {
  code: 'code_1c',
  name: 'name',
  mpn: 'manufacturer_part_number',
  qty: 'quantity',
  unit: 'unit',
  model: 'vehicle_model',
  make: 'vehicle_make',
  price: 'price',
} as const;
type Column = keyof typeof COLUMNS;
type Cells = Partial<Record<Column, string>>;

const ALL = Object.keys(COLUMNS) as Column[];
const DEFAULTS: Cells = {
  name: 'Чашка переднего амортизатора',
  // What the new export holds in this column: a brand, never the number.
  mpn: 'SKODA',
  qty: '8',
  unit: 'шт.',
  model: 'COBALT',
  make: 'CHEVROLET',
  price: '130,000',
};

/** A tab-delimited export; a cell given as '' stays empty. */
function exportFile(rows: Cells[]): Buffer {
  const lines = rows.map((r) =>
    ALL.map((c) => (c in r ? r[c] : DEFAULTS[c]) ?? '').join('\t'),
  );
  return Buffer.from(
    [ALL.map((c) => COLUMNS[c]).join('\t'), ...lines].join('\r'),
    'utf-8',
  );
}

function setup() {
  const db = new FakeDb(driversVillageFixture());
  const store = new FakeDriversVillageStore(db);
  const projection = new CatalogProjectionService(fakeCatalogPrisma(db).prisma);
  const service = new DriversVillageImportService(store, projection);
  const run = (bytes: Buffer, dryRun = false) =>
    service.run(bytes, 'dv.txt', { dryRun });
  const stockOf = (code: string) =>
    db.state.stocks.find((s) => s.sourceCode === code)!;
  const productOf = (code: string) =>
    db.state.products.find((p) => p.id === stockOf(code).productId)!;
  const partOf = (code: string) =>
    db.state.catalogParts.find(
      (c) => c.id === `part_stock_${stockOf(code).id}`,
    )!;
  return { db, store, run, stockOf, productOf, partOf };
}

describe('Driver’s Village — code_1c is the part number', () => {
  it('a new position takes its part number from code_1c: case, leading zeros and symbols kept', async () => {
    const { run, stockOf, productOf, partOf } = setup();
    // The index: the normalized code, then its 8-digit key when it has one.
    const cases: [code: string, mpn: string, index: string[]][] = [
      ['565-853-621-B-FOD', 'SKODA', ['565853621BFOD']],
      ['000342222', 'skoda', ['000342222']],
      ['96273708Heinner', 'Onix', ['96273708HEINNER', '96273708']],
      ['06H-905-110-G', '', ['06H905110G']],
    ];
    const report = await run(
      exportFile(cases.map(([code, mpn]) => ({ code, mpn }))),
    );

    expect(report.summary).toMatchObject({ rowsToCreate: 4, rejectedRows: 0 });
    for (const [code, , index] of cases) {
      expect(stockOf(code).sourceCode).toBe(code);
      expect(productOf(code)).toMatchObject({
        sourcePartNumber: code,
        oemNumbers: index,
      });
      expect(partOf(code).oemNumbers).toEqual(index);
    }
    expect(report.rows[0].partNumber).toEqual({
      from: null,
      to: '565-853-621-B-FOD',
    });
  });

  it('a stored part number is never changed by the sync: the difference is reported, not written', async () => {
    const { db, run, stockOf, productOf, partOf } = setup();
    const file = exportFile([{ code: '95015324', mpn: 'SKODA' }]);
    await run(file);
    const ids = {
      stock: stockOf('95015324').id,
      product: productOf('95015324').id,
    };
    // A stored number that differs from code_1c (an old import stored the
    // brand): Mator owns the card of a stored position.
    Object.assign(productOf('95015324'), {
      sourcePartNumber: 'SKODA',
      oemNumbers: ['SKODA'],
    });
    partOf('95015324').oemNumbers = ['SKODA'];
    const snapshot = JSON.stringify(db.state);

    const report = await run(file);

    expect(report.rows[0]).toMatchObject({
      outcome: 'unchanged',
      changes: [],
      notApplied: ['part_number'],
      written: 'skipped_unchanged',
    });
    expect(report.summary.rowsWithCardDifferences).toBe(1);
    expect(JSON.stringify(db.state)).toBe(snapshot);
    expect(productOf('95015324')).toMatchObject({
      id: ids.product,
      sourcePartNumber: 'SKODA',
      oemNumbers: ['SKODA'],
    });
    expect(partOf('95015324').oemNumbers).toEqual(['SKODA']);
    expect(stockOf('95015324').id).toBe(ids.stock);
  });

  it('a stored part number never decides which position a row updates; other sellers’ products are untouched', async () => {
    const { db, run, stockOf, productOf } = setup();
    await run(
      exportFile([
        { code: 'AAA-111', price: '100' },
        { code: 'BBB-222', price: '200' },
      ]),
    );
    // AAA-111 wrongly stores BBB-222's number; a Telegram listing and another
    // seller's imported stock carry the same values.
    productOf('AAA-111').sourcePartNumber = 'BBB-222';
    productOf('AAA-111').oemNumbers = ['BBB222'];
    db.state.sellers.push({
      id: 99,
      sellerType: 'TELEGRAM',
      tgId: BigInt(5),
      status: 'ACTIVE',
      catalogSellerId: null,
    });
    const foreign = {
      id: 1,
      gmNumber: 'BBB-222',
      title: 'Telegram listing',
      gmNumbers: [],
      sourcePartNumber: 'BBB-222',
      oemNumbers: ['BBB222'],
      categoryId: null,
      vehicleCategoryId: null,
      mainCategory: null,
      vehicleCategory: null,
      isUniversal: true,
      imageUrl: null,
      description: null,
    };
    db.state.products.push(foreign);
    db.state.stocks.push({
      id: 2,
      sellerId: 99,
      productId: 1,
      sourceSystem: 'DRIVERS_VILLAGE_1C',
      sourceCode: 'BBB-222',
      priceUzs: '5',
      quantity: 1,
      unit: 'PCS',
    });
    const untouched = JSON.stringify([
      db.state.products.find((p) => p.id === 1),
      db.state.stocks.find((s) => s.id === 2),
      productOf('AAA-111'),
      stockOf('AAA-111'),
    ]);

    // The row names AAA-111 in its part-number cell; only code_1c counts.
    const report = await run(
      exportFile([{ code: 'BBB-222', mpn: 'AAA-111', price: '300' }]),
    );

    expect(report.summary).toMatchObject({ rowsToUpdate: 1, rowsToCreate: 0 });
    const dv = db.state.stocks.find(
      (s) => s.sellerId === 7 && s.sourceCode === 'BBB-222',
    )!;
    expect(dv.priceUzs).toBe('300000');
    expect(
      JSON.stringify([
        db.state.products.find((p) => p.id === 1),
        db.state.stocks.find((s) => s.id === 2),
        productOf('AAA-111'),
        stockOf('AAA-111'),
      ]),
    ).toBe(untouched);
    expect(db.state.stocks).toHaveLength(3);
  });
});

describe('Driver’s Village — a repeated code_1c is one position at its highest valid price', () => {
  it.each([
    ['first', ['900', '500', '700'], 2],
    ['middle', ['500', '900', '700'], 3],
    ['last', ['500', '700', '900'], 4],
  ])(
    'the highest price wins wherever it is (%s row)',
    async (_where, prices, chosenLine) => {
      const { db, run, stockOf, partOf } = setup();
      const report = await run(
        exportFile(prices.map((price) => ({ code: 'D-100', price }))),
      );

      expect(report.summary).toMatchObject({
        duplicateSourceCodes: 1,
        duplicateCodesMaxPrice: 1,
        rowsMerged: 2,
        rowsToCreate: 1,
        rejectedRows: 0,
      });
      expect(report.duplicates).toEqual([
        {
          code1c: 'D-100',
          rows: 3,
          lines: [2, 3, 4],
          chosenLine,
          priceUzs: '900000.00',
          differs: [],
        },
      ]);
      expect(report.rows.find((r) => r.line === chosenLine)!.outcome).toBe(
        'create',
      );
      expect(stockOf('D-100').priceUzs).toBe('900000');
      expect(partOf('D-100').priceUzs).toBe('900000');
      expect(db.state.stocks).toHaveLength(1);
      expect(db.state.products).toHaveLength(1);
      expect(db.state.catalogParts).toHaveLength(1);
    },
  );

  it('name and unit come from the chosen row (a tie: the first); differing quantities give none', async () => {
    const { run, stockOf, productOf } = setup();
    const report = await run(
      exportFile([
        { code: 'T-100', price: '700', qty: '3', name: 'Губка' },
        { code: 'T-100', price: '900', qty: '5', name: 'Губка кора' },
        { code: 'T-100', price: '900,000', qty: '7', name: 'Губка большая' },
      ]),
    );

    expect(report.duplicates[0]).toMatchObject({
      chosenLine: 3,
      priceUzs: '900000.00',
      differs: ['name', 'quantity'],
    });
    // Batches or warehouses? No confirmed count: the stock gets the column
    // default, never one row's quantity or a sum.
    expect(stockOf('T-100')).toMatchObject({ priceUzs: '900000', quantity: 1 });
    expect(productOf('T-100').title).toBe('Губка кора');
    const chosen = report.rows.find((r) => r.line === 3)!;
    expect(chosen.quantity).toEqual({ from: null, to: null });
    expect(chosen.issues.map((i) => i.code)).toContain(
      'duplicate_quantities_differ',
    );
    expect(report.summary.codesWithAmbiguousQuantity).toBe(1);
  });

  it('an invalid price never wins against a valid one; it is only a warning', async () => {
    const { run, stockOf } = setup();
    const report = await run(
      exportFile([
        { code: 'V-100', price: '1,600,000' },
        { code: 'V-100', price: '500' },
        { code: 'V-100', price: 'abc' },
        { code: 'V-100', price: '0' },
      ]),
    );

    expect(stockOf('V-100').priceUzs).toBe('500000');
    expect(report.summary).toMatchObject({
      rowsToCreate: 1,
      rowsMerged: 3,
      rejectedRows: 0,
      dataErrors: 0,
      codesWithoutValidPrice: 0,
    });
    for (const line of [2, 4, 5]) {
      const r = report.rows.find((x) => x.line === line)!;
      expect(r.outcome).toBe('merged');
      expect(r.issues.map((i) => [i.code, i.severity])).toEqual([
        ['invalid_price', 'warning'],
        ['duplicate_code_1c', 'warning'],
      ]);
    }
  });

  it('a row rejected for another reason does not compete, even with a higher price', async () => {
    const { run, stockOf } = setup();
    const report = await run(
      exportFile([
        { code: 'U-100', price: '900', unit: 'комп.' },
        { code: 'U-100', price: '500' },
      ]),
    );

    expect(stockOf('U-100').priceUzs).toBe('500000');
    expect(report.rows.map((r) => r.outcome)).toEqual(['rejected', 'create']);
    expect(report.rows[0].issues.map((i) => i.code)).toEqual([
      'unknown_unit',
      'duplicate_code_1c',
    ]);
  });

  it('when no row of a code has a valid price, nothing is written and the stored price stays', async () => {
    const { db, run, stockOf, partOf } = setup();
    await run(exportFile([{ code: 'Z-100', price: '690', qty: '8' }]));
    const before = JSON.stringify({
      stock: stockOf('Z-100'),
      part: partOf('Z-100'),
    });

    const report = await run(
      exportFile([
        { code: 'Z-100', price: '0', qty: '1' },
        { code: 'Z-100', price: '' },
        { code: 'Z-100', price: '-5' },
        { code: 'Y-100', price: '0' },
      ]),
    );

    expect(report.summary).toMatchObject({
      codesWithoutValidPrice: 2,
      duplicateSourceCodes: 1,
      duplicateCodesMaxPrice: 0,
      rejectedRows: 4,
      rowsToCreate: 0,
      rowsToUpdate: 0,
    });
    expect(report.duplicates[0]).toMatchObject({
      code1c: 'Z-100',
      chosenLine: null,
      priceUzs: null,
    });
    for (const r of report.rows.slice(0, 3))
      expect(r.issues.map((i) => [i.code, i.severity])).toEqual([
        ['invalid_price', 'error'],
        ['no_valid_price', 'error'],
      ]);
    expect(
      JSON.stringify({ stock: stockOf('Z-100'), part: partOf('Z-100') }),
    ).toBe(before);
    expect(stockOf('Z-100').priceUzs).toBe('690000');
    expect(db.state.stocks.map((s) => s.sourceCode)).toEqual(['Z-100']);
  });

  it('re-importing a file with repeated codes is idempotent: no duplicates, nothing rewritten', async () => {
    const { db, store, run } = setup();
    const file = exportFile([
      { code: 'R-100', price: '500' },
      { code: 'R-100', price: '900' },
      { code: 'S-100', price: '700' },
    ]);
    await run(file);
    const snapshot = JSON.stringify(db.state);
    const batches = store.applyBatchCalls;

    const again = await run(file);

    expect(again.summary).toMatchObject({
      rowsUnchanged: 2,
      rowsMerged: 1,
      rowsToCreate: 0,
      rowsToUpdate: 0,
    });
    expect(store.applyBatchCalls).toBe(batches);
    expect(JSON.stringify(db.state)).toBe(snapshot);
    expect(db.state.stocks).toHaveLength(2);
  });

  it('dry-run reports the chosen prices and card differences, and writes nothing', async () => {
    const { db, store, run, productOf } = setup();
    await run(exportFile([{ code: 'Q-100', price: '100' }]));
    productOf('Q-100').sourcePartNumber = 'SKODA';
    const snapshot = JSON.stringify(db.state);
    const batches = store.applyBatchCalls;
    const calls = db.calls.length;

    const report = await run(
      exportFile([
        { code: 'Q-100', price: '200' },
        { code: 'Q-100', price: '300' },
        { code: 'N-100', price: '50' },
      ]),
      true,
    );

    expect(report.meta.mode).toBe('dry-run');
    expect(report.summary).toMatchObject({
      rowsToUpdate: 1,
      rowsToCreate: 1,
      rowsMerged: 1,
      duplicateCodesMaxPrice: 1,
      rowsWithCardDifferences: 1, // the stored part number, never written
      written: null,
    });
    expect(report.duplicates[0]).toMatchObject({
      code1c: 'Q-100',
      chosenLine: 3,
      priceUzs: '300000.00',
    });
    expect(store.applyBatchCalls).toBe(batches);
    expect(db.calls).toHaveLength(calls);
    expect(JSON.stringify(db.state)).toBe(snapshot);
  });
});
