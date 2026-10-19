/**
 * Test-only harness for end-to-end Driver's Village import specs: a synthetic
 * tab-delimited export, and the real importer and the REAL Stock → CatalogPart
 * projection wired to the in-memory fakes. No database.
 */
import { CatalogProjectionService } from '../../src/catalog/projection/catalog-projection.service';
import { DriversVillageImportService } from '../../src/imports/drivers-village/drivers-village-import.service';
import {
  driversVillageFixture,
  FakeDb,
  FakeDriversVillageStore,
  type FakeStoreOptions,
} from './drivers-village-fake-db';
import { fakeCatalogPrisma } from './drivers-village-fake-catalog';

const COLUMNS = {
  code: 'code_1c',
  name: 'name',
  qty: 'quantity',
  unit: 'unit',
  model: 'vehicle_model',
  make: 'vehicle_make',
  price: 'price',
} as const;
export type Column = keyof typeof COLUMNS;
export type Cells = Partial<Record<Column, string>>;
const ALL = Object.keys(COLUMNS) as Column[];
const DEFAULTS: Cells = {
  name: 'Фильтр масляный',
  qty: '8',
  unit: 'шт.',
  model: 'COBALT',
  make: 'CHEVROLET',
  price: '150000',
};

/** A tab-delimited export of the given columns. */
export function exportFile(rows: Cells[], columns: Column[] = ALL): Buffer {
  const lines = rows.map((r) =>
    columns.map((c) => (c in r ? r[c] : DEFAULTS[c]) ?? '').join('\t'),
  );
  return Buffer.from(
    [columns.map((c) => COLUMNS[c]).join('\t'), ...lines].join('\r'),
    'utf-8',
  );
}

export function importHarness(storeOptions: FakeStoreOptions = {}) {
  const db = new FakeDb(driversVillageFixture());
  const store = new FakeDriversVillageStore(db, storeOptions);
  const service = new DriversVillageImportService(
    store,
    new CatalogProjectionService(fakeCatalogPrisma(db).prisma),
  );
  const run = (
    rows: Cells[],
    opts: { dryRun?: boolean; columns?: Column[] } = {},
  ) =>
    service.run(exportFile(rows, opts.columns), 'dv.txt', {
      dryRun: opts.dryRun ?? false,
    });
  const stockOf = (code: string) =>
    db.state.stocks.find((s) => s.sourceCode === code);
  const productOf = (code: string) =>
    db.state.products.find((p) => p.id === stockOf(code)?.productId);
  const partOf = (code: string) =>
    db.state.catalogParts.find(
      (c) => c.id === `part_stock_${stockOf(code)?.id}`,
    );
  /** Every row of one position — stock, product, catalog part, links, photos. */
  const position = (code: string) => {
    const productId = stockOf(code)?.productId;
    return JSON.stringify({
      stock: stockOf(code),
      product: productOf(code),
      part: partOf(code),
      models: db.state.partModels.filter((m) => m.partId === productId),
      makes: db.state.partMakes.filter((m) => m.partId === productId),
      images: db.state.productImages.filter((i) => i.productId === productId),
    });
  };
  return { db, store, run, stockOf, productOf, partOf, position };
}
