/**
 * End to end without a database: an export posted by the 1C bot goes through
 * the ingest into the REAL DriversVillageImportService and the REAL
 * Stock → CatalogPart projection over the in-memory fakes. Proves that the
 * Telegram path applies the importer's rules unchanged — code_1c is the part
 * number, and a repeated code_1c is one position at its highest valid price —
 * because the ingest hands the importer the file byte for byte.
 *
 * In production the runner is the importer CLI (import-runner.ts); here an
 * in-process runner calls the same service and maps the report to the CLI's
 * exit codes (scripts/import-drivers-village.ts).
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import {
  driversVillageFixture,
  FakeDb,
  FakeDriversVillageStore,
} from '../../../../test/utils/drivers-village-fake-db';
import { fakeCatalogPrisma } from '../../../../test/utils/drivers-village-fake-catalog';
import {
  FakeChat,
  MemoryLogger,
  NOW,
  privateTempDir,
  testConfig,
} from '../../../../test/utils/dv-telegram-fakes';
import { CatalogProjectionService } from '../../../catalog/projection/catalog-projection.service';
import { DriversVillageImportService } from '../drivers-village-import.service';
import type {
  ImportRequest,
  ImportRunner,
  ImportRunResult,
} from './import-runner';
import { runSync } from './ingest';

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
  mpn: 'SKODA',
  qty: '8',
  unit: 'шт.',
  model: 'COBALT',
  make: 'CHEVROLET',
  price: '130,000',
};

function exportFile(rows: Cells[]): string {
  const lines = rows.map((r) =>
    ALL.map((c) => (c in r ? r[c] : DEFAULTS[c]) ?? '').join('\t'),
  );
  return [ALL.map((c) => COLUMNS[c]).join('\t'), ...lines].join('\r');
}

class InProcessImporter implements ImportRunner {
  constructor(private readonly service: DriversVillageImportService) {}

  async run(request: ImportRequest): Promise<ImportRunResult> {
    const report = await this.service.run(
      readFileSync(request.file),
      basename(request.file),
      {
        dryRun: request.dryRun,
      },
    );
    const s = report.summary;
    const exitCode = report.meta.aborted
      ? 1
      : s.rejectedRows || s.written?.projectionFailures
        ? 2
        : 0;
    return {
      exitCode,
      signal: null,
      timedOut: false,
      aborted: false,
      spawnError: null,
      report,
      reportPath: null,
    };
  }
}

function setup() {
  const db = new FakeDb(driversVillageFixture());
  const service = new DriversVillageImportService(
    new FakeDriversVillageStore(db),
    new CatalogProjectionService(fakeCatalogPrisma(db).prisma),
  );
  const config = testConfig(privateTempDir());
  const chat = new FakeChat();
  const sync = () =>
    runSync(
      {
        config,
        source: chat,
        runner: new InProcessImporter(service),
        log: new MemoryLogger(),
        now: () => NOW,
      },
      'sync',
    );
  const stockOf = (code: string) =>
    db.state.stocks.find((s) => s.sourceCode === code)!;
  const productOf = (code: string) =>
    db.state.products.find((p) => p.id === stockOf(code).productId)!;
  const partOf = (code: string) =>
    db.state.catalogParts.find(
      (c) => c.id === `part_stock_${stockOf(code).id}`,
    )!;
  return { db, chat, sync, stockOf, productOf, partOf };
}

describe('Driver’s Village — an export from Telegram is imported by the one importer', () => {
  it('code_1c is the part number; a repeated code_1c is one position at its highest valid price', async () => {
    const { db, chat, sync, stockOf, productOf, partOf } = setup();
    chat.post(
      11,
      exportFile([
        { code: 'D-100', price: '500', mpn: 'SKODA' },
        { code: 'D-100', price: '900', mpn: 'Onix' },
        { code: 'D-100', price: 'по запросу' },
        { code: 'D-100', price: '700' },
        { code: '95015324', price: '130,000', mpn: 'SKODA' },
      ]),
      { fileName: 'dv_parts_2026_10_18.txt' },
    );

    const summary = await sync();

    expect(summary).toMatchObject({ imported: 1, failed: 0, waiting: 0 });
    expect(stockOf('D-100').priceUzs).toBe('900000');
    expect(partOf('D-100').priceUzs).toBe('900000');
    expect(productOf('D-100').sourcePartNumber).toBe('D-100');
    expect(productOf('95015324')).toMatchObject({
      sourcePartNumber: '95015324',
      oemNumbers: ['95015324'],
    });
    expect(stockOf('95015324').priceUzs).toBe('130000');
    // The manufacturer_part_number cells (SKODA, Onix) never become a number.
    for (const p of db.state.products) {
      expect(p.sourcePartNumber).not.toMatch(/SKODA|Onix/);
      expect(p.oemNumbers).not.toContain('SKODA');
    }
    expect(db.state.stocks).toHaveLength(2);
    expect(db.state.products).toHaveLength(2);
  });

  it('the same export re-sent is not imported twice; a changed export updates in place', async () => {
    const { db, chat, sync, stockOf } = setup();
    const first = exportFile([
      { code: 'D-100', price: '500' },
      { code: 'D-100', price: '900' },
    ]);
    chat.post(11, first);
    await sync();
    const stockId = stockOf('D-100').id;

    chat.post(12, first);
    expect(await sync()).toMatchObject({ imported: 0, duplicates: 1 });

    chat.post(
      13,
      exportFile([
        { code: 'D-100', price: '400' },
        { code: 'D-100', price: '950' },
      ]),
    );
    expect(await sync()).toMatchObject({ imported: 1 });
    expect(stockOf('D-100')).toMatchObject({ id: stockId, priceUzs: '950000' });
    expect(db.state.stocks).toHaveLength(1);
  });
});
