/**
 * The 1C ";" export end to end — the real importer and the REAL Stock →
 * CatalogPart projection over the in-memory fakes, no database.
 *
 * test/fixtures/drivers-village/dv-parts-2026-10-18.anonymized.txt has the
 * byte layout of the real dv_parts_2026_10_18.txt (UTF-8 BOM, CRLF, ";", its
 * 20 columns in its order, a stray BOM as the last line) and synthetic rows
 * reproducing its problem cases: prices "1,100,000", quantities "2,268" /
 * "12.5" / "-3", an article with "&", an 8-digit article with a marker
 * ("96273708 GMB", next to "96273708"), placeholder codes "1" / "3333"
 * shared by unrelated goods, repeated codes at several prices, units "штук" /
 * "1" / "комп.". Names, codes and prices are invented.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import {
  driversVillageFixture,
  FakeDb,
  FakeDriversVillageStore,
} from '../../../test/utils/drivers-village-fake-db';
import { fakeCatalogPrisma } from '../../../test/utils/drivers-village-fake-catalog';
import { DriversVillageImportService } from './drivers-village-import.service';

const FIXTURE = readFileSync(
  join(
    __dirname,
    '../../../test/fixtures/drivers-village/dv-parts-2026-10-18.anonymized.txt',
  ),
);

function setup() {
  const db = new FakeDb(driversVillageFixture());
  const service = new DriversVillageImportService(
    new FakeDriversVillageStore(db),
    new CatalogProjectionService(fakeCatalogPrisma(db).prisma),
  );
  const run = (bytes: Buffer, dryRun = false) =>
    service.run(bytes, 'dv_parts.txt', { dryRun });
  const stockOf = (code: string) =>
    db.state.stocks.find((s) => s.sourceCode === code);
  const productOf = (code: string) =>
    db.state.products.find((p) => p.id === stockOf(code)?.productId);
  /** code_1c → [stored price, stored quantity] of every stock. */
  const written = (): Record<string, [string, number]> =>
    Object.fromEntries(
      db.state.stocks.map((s): [string, [string, number]] => [
        s.sourceCode ?? '',
        [s.priceUzs, s.quantity],
      ]),
    );
  return { db, run, stockOf, productOf, written };
}

type Format = 'semicolon' | 'tab';
interface Line {
  code: string;
  name?: string;
  /** Logical numbers ("1100000", "12.5"); 'bad' = an invalid cell. */
  price: string;
  qty?: string;
}

/** The same rows written the way each source format writes them. */
function exportFile(lines: Line[], format: Format): Buffer {
  const number = (value: string) => {
    if (value === 'bad') return 'по запросу';
    const [int, frac] = value.split('.');
    const groups = int.replace(
      /\B(?=(\d{3})+$)/g,
      format === 'tab' ? ' ' : ',',
    );
    return frac ? `${groups}${format === 'tab' ? ',' : '.'}${frac}` : groups;
  };
  const d = format === 'tab' ? '\t' : ';';
  const rows = lines.map((l) =>
    [
      l.code,
      l.name ?? 'Амортизатор задний',
      number(l.qty ?? '1'),
      'шт.',
      number(l.price),
      'CHEVROLET',
      'COBALT',
    ].join(d),
  );
  const header = [
    'code_1c',
    'name',
    'quantity',
    'unit',
    'price',
    'vehicle_make',
    'vehicle_model',
  ];
  return Buffer.from([header.join(d), ...rows].join('\r\n'), 'utf-8');
}

describe('Driver’s Village — the 1C ";" export (anonymized dv_parts_2026_10_18)', () => {
  it('detects the format and imports exactly the valid positions, each at its own price and quantity', async () => {
    const { run, written } = setup();
    const report = await run(FIXTURE);

    expect(report.meta).toMatchObject({
      aborted: false,
      encoding: 'utf-8',
      delimiter: 'semicolon',
      numberFormat: 'thousands-comma',
    });
    expect(report.headers.notImported).toEqual(
      expect.arrayContaining([
        'manufacturer_part_number',
        'oem_numbers',
        'category_id',
        'subcategory_id',
      ]),
    );
    expect(report.headers.ignored).toEqual(
      expect.arrayContaining([
        'currency',
        'brand',
        'description',
        'photo_urls',
      ]),
    );
    expect(report.summary).toMatchObject({
      totalRows: 31,
      rowsToCreate: 15,
      rowsMerged: 4,
      rejectedRows: 12,
    });
    expect(written()).toEqual({
      '96273708': ['123456', 12],
      '96273708 GMB': ['150000', 5],
      '95015324': ['1100000', 2268],
      '000342222': ['12345', 8],
      '_00-00001431': ['45000', 4],
      '_БП-01068170': ['210000', 3],
      '5Q0-615-301-F': ['890000', 6],
      '96535102': ['140000', 100],
      '96810038S&T': ['80000', 7],
      // Repeated codes whose rows state different quantities: no confirmed
      // count, so the new stock gets the column default.
      '96350526': ['520000', 1],
      '96407822': ['310000', 1],
      '96328210': ['60000', 4],
      '96182221': ['98000', 24],
      '96328215': ['2500', 1234],
      '96399999': ['1234567', 3],
    });
  });

  it('rejects each problem row of the real export with its reason, writing nothing of it', async () => {
    const { run } = setup();
    const report = await run(FIXTURE);
    const errors = (line: number) =>
      report.rows
        .find((r) => r.line === line)!
        .issues.filter((i) => i.severity === 'error')
        .map((i) => i.code);

    expect(errors(8)).toEqual(['invalid_quantity']); // 12.5 л
    expect(errors(9)).toEqual(['invalid_quantity']); // -3
    expect(errors(10)).toEqual(['invalid_price']); // 0
    expect(errors(13)).toEqual([]); // "96810038S&T" is an article: accepted
    for (const line of [14, 15, 16, 17, 18])
      expect(errors(line)).toContain('placeholder_code_1c'); // "1", "3333"
    expect(errors(26)).toEqual(['unknown_unit']); // unit "1"
    expect(errors(27)).toEqual(['unknown_unit']); // "комп."
    expect(errors(29)).toEqual(['invalid_price']); // "12,34" — not read as 12.34 or 1234
    expect(errors(30)).toEqual(['invalid_quantity']); // 1,234.5
  });

  it('"96273708 GMB" next to "96273708": two positions sharing the 8-digit key, reported, never merged', async () => {
    const { run, productOf } = setup();
    const report = await run(FIXTURE);
    const row = (line: number) => report.rows.find((r) => r.line === line)!;

    for (const line of [2, 12]) {
      expect(row(line)).toMatchObject({
        outcome: 'create',
        written: 'created',
      });
      expect(row(line).issues.map((i) => i.code)).toContain('code_key_shared');
    }
    expect(report.summary).toMatchObject({
      rowsToCreateWithSharedKey: 2,
      rowsWithPossibleRename: 0, // nothing stored yet
    });
    expect(productOf('96273708 GMB')).toMatchObject({
      title: 'Фильтр масляный оригинал',
      sourcePartNumber: '96273708 GMB',
    });
  });

  it('a repeated code_1c: the price of the first row at the highest valid price; differing quantities give none — with review warnings', async () => {
    const { run } = setup();
    const report = await run(FIXTURE);
    const row = (line: number) => report.rows.find((r) => r.line === line)!;

    expect(report.duplicates.find((d) => d.code1c === '96350526')).toEqual({
      code1c: '96350526',
      rows: 4,
      lines: [19, 20, 21, 22],
      chosenLine: 20,
      priceUzs: '520000.00',
      differs: ['quantity'],
    });
    expect(row(20)).toMatchObject({ outcome: 'create', written: 'created' });
    expect([19, 21, 22, 23].map((l) => row(l).outcome)).toEqual([
      'merged',
      'merged',
      'merged',
      'merged',
    ]);
    expect(
      row(20).issues.find((i) => i.code === 'duplicate_quantities_differ'),
    ).toMatchObject({
      severity: 'warning',
      field: 'quantity',
    });
    expect(
      row(20).issues.find((i) => i.code === 'duplicate_quantities_differ')!
        .message,
    ).toMatch(/no quantity is confirmed and none is imported.*never added up/);
    expect(row(20).quantity).toEqual({ from: null, to: null });
    expect(row(24).issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'duplicate_code_1c',
        'duplicate_names_differ',
        'duplicate_quantities_differ',
      ]),
    );
  });

  it('code_1c is the part number; the file’s part-number, description and photo cells never reach the database', async () => {
    const { db, run, productOf } = setup();
    await run(FIXTURE);
    expect(productOf('96273708')).toMatchObject({
      sourcePartNumber: '96273708',
      oemNumbers: ['96273708'],
      categoryId: null,
    });
    expect(productOf('96273708')!.description ?? null).toBeNull();
    expect(productOf('96273708')!.imageUrl ?? null).toBeNull();
    expect(productOf('000342222')!.sourcePartNumber).toBe('000342222');
    expect(productOf('_БП-01068170')).toMatchObject({
      sourcePartNumber: '_БП-01068170',
      oemNumbers: ['01068170'], // the 8-digit key; the code is not indexable
    });
    expect(db.state.productImages).toEqual([]);
  });

  it('re-importing the same export changes nothing', async () => {
    const { db, run } = setup();
    await run(FIXTURE);
    const before = JSON.stringify(db.state);
    const again = await run(FIXTURE);
    expect(again.summary).toMatchObject({
      rowsToCreate: 0,
      rowsToUpdate: 0,
      rowsUnchanged: 15,
    });
    expect(again.summary.written).toMatchObject({ created: 0, updated: 0 });
    expect(JSON.stringify(db.state)).toBe(before);
  });
});

describe('Driver’s Village — a repeated code_1c, in both source formats', () => {
  const GROUP: Line[] = [
    { code: 'D-200', price: '500000', qty: '5' },
    { code: 'D-200', price: '900000', qty: '7' },
    { code: 'D-200', price: '900000', qty: '9' },
    { code: 'D-200', price: 'bad', qty: '11' },
    { code: 'D-200', price: '700000', qty: '13' },
  ];
  const permutations = <T>(items: T[]): T[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((x, i) =>
          permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(
            (p) => [x, ...p],
          ),
        );

  it.each<Format>(['semicolon', 'tab'])(
    '%s: in every order of the rows, the price comes from the first row at the highest valid price; the differing quantities give none',
    async (format) => {
      expect(permutations(GROUP)).toHaveLength(120);
      for (const order of permutations(GROUP)) {
        const { run, written } = setup();
        const report = await run(exportFile(order, format));
        const first = order.find((l) => l.price === '900000')!;
        expect(written()).toEqual({ 'D-200': ['900000', 1] });
        expect(report.duplicates[0].chosenLine).toBe(order.indexOf(first) + 2);
        expect(report.summary.rowsMerged).toBe(4);
      }
    },
  );

  it('both formats give the same positions for the same rows', async () => {
    const lines: Line[] = [
      ...GROUP,
      { code: '95015324', price: '1100000', qty: '2268' },
      { code: '96535102', price: '140', qty: '100' },
      { code: '96328214', price: '1500', qty: '12.5' }, // fractional: rejected in both
    ];
    const semicolon = setup();
    const tab = setup();
    await semicolon.run(exportFile(lines, 'semicolon'));
    await tab.run(exportFile(lines, 'tab'));
    expect(semicolon.written()).toEqual({
      'D-200': ['900000', 1],
      '95015324': ['1100000', 2268],
      '96535102': ['140000', 100],
    });
    expect(tab.written()).toEqual(semicolon.written());
  });

  it('no valid positive price in the group: nothing is written — the stored price and quantity stay', async () => {
    const { run, stockOf } = setup();
    await run(
      exportFile([{ code: 'K-100', price: '690000', qty: '8' }], 'semicolon'),
    );
    const report = await run(
      exportFile(
        [
          { code: 'K-100', price: 'bad', qty: '3' },
          { code: 'K-100', price: '0', qty: '4' },
        ],
        'semicolon',
      ),
    );
    expect(stockOf('K-100')).toMatchObject({ priceUzs: '690000', quantity: 8 });
    expect(report.rows.map((r) => r.outcome)).toEqual(['rejected', 'rejected']);
    expect(report.rows[0].issues.map((i) => i.code)).toContain(
      'no_valid_price',
    );
  });

  it('a changed export updates the same position in place; a position missing from it is kept as it is', async () => {
    const { db, run, stockOf } = setup();
    await run(
      exportFile(
        [
          { code: 'D-200', price: '500000', qty: '5' },
          { code: 'D-200', price: '900000', qty: '7' },
          { code: 'E-300', price: '120000', qty: '2' },
        ],
        'semicolon',
      ),
    );
    const ids = { d: stockOf('D-200')!.id, e: stockOf('E-300')!.id };
    const keptE = JSON.stringify(stockOf('E-300'));
    const report = await run(
      exportFile(
        [
          { code: 'D-200', price: '950000', qty: '2' },
          { code: 'D-200', price: '900000', qty: '7' },
        ],
        'semicolon',
      ),
    );
    // The price follows the export; its rows still state different
    // quantities, so the stored count is kept.
    expect(stockOf('D-200')).toMatchObject({
      id: ids.d,
      priceUzs: '950000',
      quantity: 1,
    });
    expect(JSON.stringify(stockOf('E-300'))).toBe(keptE);
    expect(stockOf('E-300')!.id).toBe(ids.e);
    expect(report.positionsNotInFile).toEqual(['E-300']);
    expect(db.state.stocks).toHaveLength(2);
  });
});

describe('Driver’s Village — code_1c that holds row numbers', () => {
  const rows = (codes: string[]): Line[] =>
    codes.map((code, i) => ({ code, price: String(100000 + i), qty: '1' }));
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

  it.each([
    ['in file order', range(1, 40)],
    ['shuffled', [...range(21, 40), ...range(1, 20)].reverse()],
    ['half the rows', [...range(1, 20), ...range(96273700, 96273719)]],
  ])(
    'refuses the whole file — %s — and writes nothing, also in a dry run',
    async (_case, codes) => {
      for (const dryRun of [false, true]) {
        const { db, run } = setup();
        const report = await run(exportFile(rows(codes), 'semicolon'), dryRun);
        expect(report.meta.aborted).toBe(true);
        expect(report.meta.abortReason).toMatch(
          /row numbers, not part numbers/,
        );
        expect(report.summary.written).toBeNull();
        expect(db.state.stocks).toEqual([]);
      }
    },
  );

  it('real numeric part numbers are no row numbers: long codes, consecutive codes, a few short codes', async () => {
    const codes = [
      ...range(96273700, 96273730), // consecutive 8-digit articles
      '294',
      '650',
      '7070',
      '000342222',
      '4607012345678',
    ];
    const { run, db } = setup();
    const report = await run(exportFile(rows(codes), 'semicolon'));
    expect(report.meta.aborted).toBe(false);
    expect(db.state.stocks).toHaveLength(codes.length);
  });
});
