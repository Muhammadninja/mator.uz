/**
 * Repeated 1C exports against one catalog — the synchronization rules, end to
 * end: the real importer and the REAL Stock → CatalogPart projection
 * (CatalogProjectionService) over in-memory fakes. No database.
 *
 * "Admin bulk-move" below is what PATCH /v1/admin/products/bulk-move does: it
 * writes catalog_parts.category_id, the column a manual classification lives in.
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
  oem: 'manufacturer_part_number',
  qty: 'quantity',
  unit: 'unit',
  model: 'vehicle_model',
  price: 'price',
  make: 'vehicle_make',
  cat: 'category_id',
  sub: 'subcategory_id',
} as const;
type Column = keyof typeof COLUMNS;
type Cells = Partial<Record<Column, string>>;

const ALL = Object.keys(COLUMNS) as Column[];
const DEFAULTS: Cells = {
  name: 'Амортизатор передний',
  oem: '96611630',
  qty: '8',
  unit: 'шт.',
  model: 'DAMAS-2',
  price: '690',
  make: 'CHEVROLET',
  cat: 'suspension-and-steering',
  sub: 'shock-absorbers',
};

/** A tab-delimited export; a cell given as '' stays empty. */
function exportFile(rows: Cells[], columns: Column[] = ALL): Buffer {
  const lines = rows.map((r) =>
    columns.map((c) => (c in r ? r[c] : DEFAULTS[c]) ?? '').join('\t'),
  );
  return Buffer.from(
    [columns.map((c) => COLUMNS[c]).join('\t'), ...lines].join('\r'),
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

describe('Driver’s Village sync — prices', () => {
  it('normalizes every source price exactly once, into the stock and the catalog part', async () => {
    const { run, stockOf, partOf } = setup();
    const cases: [string, string][] = [
      ['690', '690000'],
      ['60', '60000'],
      ['6', '6000'],
      ['6,5', '6500'],
      ['68,7', '68700'],
      ['320,65', '320650'],
      ['530,560', '530560'],
      ['999,999', '999999'],
      ['1000', '1000'],
      ['12500', '12500'],
    ];
    const report = await run(
      exportFile(cases.map(([price], i) => ({ code: `P-${i}`, price }))),
    );

    expect(report.summary).toMatchObject({
      rowsToCreate: 10,
      rejectedRows: 0,
      rowsWithScaledPrice: 8,
    });
    cases.forEach(([, stored], i) => {
      expect(stockOf(`P-${i}`).priceUzs).toBe(stored);
      expect(partOf(`P-${i}`).priceUzs).toBe(stored);
    });
    expect(report.prices.examples[0]).toEqual({
      line: 2,
      code1c: 'P-0',
      source: '690',
      scaled: true,
      from: null,
      to: '690000.00',
    });
    expect(report.prices.examples.filter((e) => !e.scaled)).toHaveLength(2);
  });

  it('re-importing the same export changes nothing — no duplicates, no second ×1000', async () => {
    const { db, store, run, stockOf } = setup();
    const file = exportFile([
      { code: 'A-1', price: '320,65' },
      { code: 'B-1', price: '12500' },
    ]);
    await run(file);
    const snapshot = JSON.stringify(db.state);
    const batches = store.applyBatchCalls;

    for (let i = 0; i < 2; i += 1) {
      const again = await run(file);
      expect(again.summary).toMatchObject({
        rowsUnchanged: 2,
        rowsToCreate: 0,
        rowsToUpdate: 0,
        rowsWithPriceChange: 0,
      });
    }
    expect(store.applyBatchCalls).toBe(batches);
    expect(JSON.stringify(db.state)).toBe(snapshot);
    expect(stockOf('A-1').priceUzs).toBe('320650');
    expect(db.state.stocks).toHaveLength(2);
    expect(db.state.products).toHaveLength(2);
    expect(db.state.catalogParts).toHaveLength(2);
  });

  it('a changed source price updates the stored and the catalog price, in place', async () => {
    const { db, run, stockOf, partOf } = setup();
    await run(exportFile([{ code: 'A-1', price: '690' }]));
    const ids = { stock: stockOf('A-1').id, part: partOf('A-1').id };

    const report = await run(exportFile([{ code: 'A-1', price: '700' }]));

    expect(report.rows[0]).toMatchObject({
      outcome: 'update',
      changes: ['price'],
      price: { source: '700', scaled: true, from: '690000', to: '700000.00' },
    });
    expect(report.summary.rowsWithPriceChange).toBe(1);
    expect(stockOf('A-1')).toMatchObject({ id: ids.stock, priceUzs: '700000' });
    expect(partOf('A-1')).toMatchObject({ id: ids.part, priceUzs: '700000' });
    expect(db.state.stocks).toHaveLength(1);
    expect(db.state.catalogParts).toHaveLength(1);
  });

  it('an invalid price is never written (not as 0, not over the stored price) and is reported', async () => {
    const { db, run, stockOf, partOf } = setup();
    await run(
      exportFile([
        { code: 'A-1', price: '690' },
        { code: 'B-1', price: '12500' },
      ]),
    );

    const report = await run(
      exportFile([
        { code: 'A-1', price: '-690', qty: '1' },
        { code: 'B-1', price: '' },
        { code: 'C-1', price: 'abc' },
        { code: 'D-1', price: '1,600,000' },
        { code: 'E-1', price: '50' },
      ]),
    );

    expect(report.summary).toMatchObject({ rejectedRows: 4, rowsToCreate: 1 });
    expect(
      report.rows
        .filter((r) => r.outcome === 'rejected')
        .map((r) => r.issues[0].message),
    ).toEqual([
      'price "-690": negative',
      'price is empty',
      'price "abc": not a plain non-negative number',
      'price "1,600,000": more than one decimal separator',
    ]);
    // The rejected rows' stored values stand — price and quantity alike.
    expect(stockOf('A-1')).toMatchObject({ priceUzs: '690000', quantity: 8 });
    expect(partOf('A-1').priceUzs).toBe('690000');
    expect(stockOf('B-1').priceUzs).toBe('12500');
    expect(db.state.stocks.map((s) => s.sourceCode)).toEqual([
      'A-1',
      'B-1',
      'E-1',
    ]);
    expect(stockOf('E-1').priceUzs).toBe('50000');
  });

  it('flags a ×1000 jump against the stored price (e.g. one stored unscaled before this rule)', async () => {
    const { run, stockOf } = setup();
    await run(exportFile([{ code: 'A-100', price: '690' }]));
    stockOf('A-100').priceUzs = '690'; // as an import without the rule stored it

    const report = await run(exportFile([{ code: 'A-100', price: '690' }]));

    expect(report.rows[0].outcome).toBe('update');
    expect(report.rows[0].issues).toEqual([
      expect.objectContaining({
        code: 'price_jump',
        severity: 'warning',
        field: 'price',
      }),
    ]);
    expect(stockOf('A-100').priceUzs).toBe('690000');
  });
});

describe('Driver’s Village sync — categories stay Mator’s', () => {
  it('a new position is created unclassified and waits in the fallback bucket', async () => {
    const { run, productOf, partOf } = setup();
    const first = await run(exportFile([{ code: 'A-1' }]));

    expect(productOf('A-1')).toMatchObject({
      categoryId: null,
      vehicleCategoryId: null,
      mainCategory: null,
      vehicleCategory: null,
    });
    expect(partOf('A-1').categoryId).toBe('cat_uncategorized');
    expect(first.summary).toMatchObject({
      newWithoutCategory: 1,
      existingWithoutCategory: 0,
    });

    const again = await run(exportFile([{ code: 'A-1' }]));
    expect(again.summary).toMatchObject({
      newWithoutCategory: 0,
      existingWithoutCategory: 1,
    });
  });

  it('a category an operator set after the first import survives every later import', async () => {
    const { run, productOf, partOf } = setup();
    await run(exportFile([{ code: 'A-1', price: '690', qty: '8' }]));
    partOf('A-1').categoryId = 'shock-absorbers'; // admin bulk-move

    const changed = await run(
      exportFile([{ code: 'A-1', price: '720', qty: '3' }]),
    );
    expect(changed.rows[0].changes).toEqual(['price', 'quantity']);
    expect(partOf('A-1')).toMatchObject({
      categoryId: 'shock-absorbers',
      priceUzs: '720000',
      stockQty: 3,
      inStock: true,
    });
    expect(productOf('A-1').categoryId).toBeNull(); // the import never wrote one

    // Other category ids in the file change nothing either.
    await run(
      exportFile([
        {
          code: 'A-1',
          price: '730',
          cat: 'brake-system',
          sub: 'front-brake-pads',
        },
      ]),
    );
    expect(partOf('A-1')).toMatchObject({
      categoryId: 'shock-absorbers',
      priceUzs: '730000',
    });
    const unchanged = await run(exportFile([{ code: 'A-1', price: '730' }]));
    expect(unchanged.summary).toMatchObject({
      rowsUnchanged: 1,
      existingWithoutCategory: 0,
    });
  });

  it('an existing product keeps its category on both sides when its price and stock change', async () => {
    const { run, productOf, partOf } = setup();
    await run(exportFile([{ code: 'A-1' }]));
    // Classified as an earlier import (or an operator) left it.
    const productClass = {
      categoryId: 'shock-absorbers',
      vehicleCategoryId: 'suspension-and-steering',
      mainCategory: 'SUSPENSION',
      vehicleCategory: 'SUSPENSION_AND_STEERING',
    };
    Object.assign(productOf('A-1'), productClass);
    Object.assign(partOf('A-1'), {
      categoryId: 'shock-absorbers',
      mainCategory: 'SUSPENSION',
      vehicleCategory: 'SUSPENSION_AND_STEERING',
    });

    await run(exportFile([{ code: 'A-1', price: '12 900', qty: '2' }]));

    expect(productOf('A-1')).toMatchObject(productClass);
    expect(partOf('A-1')).toMatchObject({
      categoryId: 'shock-absorbers',
      mainCategory: 'SUSPENSION',
      vehicleCategory: 'SUSPENSION_AND_STEERING',
      priceUzs: '12900',
      stockQty: 2,
    });
  });

  it('empty source cells never clear what Mator owns', async () => {
    const { db, run, stockOf, productOf, partOf } = setup();
    await run(exportFile([{ code: 'A-1', qty: '8' }]));
    const product = productOf('A-1');
    Object.assign(product, {
      description: 'manual',
      ratingAvg: '4.5',
      reviewCount: 3,
      imageUrl: 'https://img/1.jpg',
    });
    db.state.productImages.push({
      productId: product.id,
      url: 'https://img/1.jpg',
    });
    // On the catalog part: the photo and rating as the photo flow / a rating
    // edit projected them, and the admin-owned columns.
    Object.assign(partOf('A-1'), {
      categoryId: 'shock-absorbers',
      purchasePriceUzs: '500000',
      cashbackPct: '5',
      images: ['https://img/1.jpg'],
      ratingAvg: '4.5',
    });

    // Blank category and quantity cells, then the final export's layout with
    // no category and no quantity columns at all.
    await run(
      exportFile([{ code: 'A-1', price: '700', qty: '', cat: '', sub: '' }]),
    );
    await run(
      exportFile(
        [{ code: 'A-1', price: '710' }],
        ['name', 'oem', 'unit', 'price', 'make', 'model', 'code'],
      ),
    );

    expect(stockOf('A-1')).toMatchObject({ priceUzs: '710000', quantity: 8 });
    expect(productOf('A-1')).toMatchObject({
      description: 'manual',
      ratingAvg: '4.5',
      reviewCount: 3,
      imageUrl: 'https://img/1.jpg',
      categoryId: null,
    });
    expect(partOf('A-1')).toMatchObject({
      categoryId: 'shock-absorbers',
      purchasePriceUzs: '500000',
      cashbackPct: '5',
      priceUzs: '710000',
      stockQty: 8,
      images: ['https://img/1.jpg'],
      ratingAvg: '4.5',
    });
  });
});

describe('Driver’s Village sync — stock and absent positions', () => {
  it('quantity 0 keeps the position, out of stock, with its category', async () => {
    const { db, run, stockOf, partOf } = setup();
    await run(exportFile([{ code: 'A-1', qty: '8' }]));
    partOf('A-1').categoryId = 'shock-absorbers';

    await run(exportFile([{ code: 'A-1', qty: '0' }]));

    expect(stockOf('A-1').quantity).toBe(0);
    expect(partOf('A-1')).toMatchObject({
      categoryId: 'shock-absorbers',
      inStock: false,
      stockQty: 0,
    });
    expect(db.state.products).toHaveLength(1);
  });

  it('a position missing from an export — even an empty export — is not deleted, zeroed or declassified', async () => {
    const { db, run, stockOf, partOf } = setup();
    await run(
      exportFile([
        { code: 'A-1', qty: '8' },
        { code: 'B-1', qty: '5' },
      ]),
    );
    partOf('B-1').categoryId = 'shock-absorbers';
    const before = JSON.stringify(partOf('B-1'));

    const partial = await run(exportFile([{ code: 'A-1', qty: '7' }]));
    const empty = await run(exportFile([]));

    expect(partial.positionsNotInFile).toEqual(['B-1']);
    expect(empty.summary.totalRows).toBe(0);
    expect(empty.positionsNotInFile).toEqual(['A-1', 'B-1']);
    expect(stockOf('B-1')).toMatchObject({ quantity: 5, priceUzs: '690000' });
    expect(JSON.stringify(partOf('B-1'))).toBe(before);
    expect(stockOf('A-1').quantity).toBe(7);
    expect(db.state.stocks).toHaveLength(2);
  });
});

describe('Driver’s Village sync — dry run', () => {
  it('reports creates, updates, price changes, examples, unclassified and errors — and writes nothing', async () => {
    const { db, store, run, partOf } = setup();
    await run(
      exportFile([
        { code: 'A-1', price: '690' },
        { code: 'B-1', price: '12500' },
        { code: 'C-1', price: '100' },
      ]),
    );
    partOf('B-1').categoryId = 'shock-absorbers';
    const snapshot = JSON.stringify(db.state);
    const batches = store.applyBatchCalls;

    const report = await run(
      exportFile([
        { code: 'A-1', price: '700' }, // update: price
        { code: 'B-1', price: '12500' }, // unchanged, classified
        { code: 'C-1', price: '0' }, // rejected
        { code: 'N-1', price: '6,5' }, // new
      ]),
      true,
    );

    expect(report.meta.mode).toBe('dry-run');
    expect(report.summary).toMatchObject({
      rowsToCreate: 1,
      rowsToUpdate: 1,
      rowsUnchanged: 1,
      rejectedRows: 1,
      rowsWithPriceChange: 1,
      rowsWithScaledPrice: 2,
      newWithoutCategory: 1,
      existingWithoutCategory: 1,
      dataErrors: 1,
      written: null,
    });
    expect(report.prices.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code1c: 'N-1',
          source: '6,5',
          to: '6500.00',
        }),
        expect.objectContaining({
          code1c: 'A-1',
          from: '690000',
          to: '700000.00',
        }),
      ]),
    );
    expect(
      report.rows.find((r) => r.code1c === 'C-1')!.issues[0],
    ).toMatchObject({
      code: 'invalid_price',
      message: 'price "0": must be greater than 0',
    });
    expect(store.applyBatchCalls).toBe(batches);
    expect(JSON.stringify(db.state)).toBe(snapshot);
  });
});
