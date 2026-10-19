/**
 * What the price/stock synchronization may write to a STORED position — its
 * stock price and a stated quantity, nothing else — and how codes identify
 * positions. End to end: the real importer and the REAL Stock → CatalogPart
 * projection over the in-memory fakes. Synthetic rows only, no database.
 */
import { importHarness } from '../../../test/utils/drivers-village-import-harness';
import { IMPORT_CLI_SCRIPT } from './telegram-ingest/import-runner';

const FINAL_1C_HEADER =
  'name\tmanufacturer_part_number\tunit\tprice\tvehicle_make\tvehicle_model\tcategory_id\tsubcategory_id\tcode_1c';

describe('Driver’s Village sync — a stored position gets its price and a stated quantity only', () => {
  it('writes the price and the stated quantity; the file’s other card values are reported, never written', async () => {
    const h = importHarness();
    await h.run([
      {
        code: 'A-1',
        name: 'Амортизатор',
        model: 'DAMAS-2, LABO',
        price: '490000',
        qty: '7',
      },
    ]);
    const product = JSON.stringify(h.productOf('A-1'));
    const links = [h.modelsOf('A-1'), h.fitsOf('A-1')];
    h.catalog.calls.length = 0;
    h.db.calls.length = 0;

    const report = await h.run([
      {
        code: 'A-1',
        name: 'Амортизатор RH новый',
        model: 'COBALT',
        unit: 'л',
        price: '510000',
        qty: '5',
      },
    ]);

    expect(report.rows[0]).toMatchObject({
      outcome: 'update',
      changes: ['price', 'quantity'],
      notApplied: ['name', 'unit', 'vehicles'],
    });
    expect(report.summary).toMatchObject({
      rowsWithPriceChange: 1,
      rowsWithQuantityChange: 1,
      rowsWithCardDifferences: 1,
    });
    expect(h.stockOf('A-1')).toMatchObject({
      priceUzs: '510000',
      quantity: 5,
      unit: 'PCS',
    });
    expect(JSON.stringify(h.productOf('A-1'))).toBe(product);
    expect([h.modelsOf('A-1'), h.fitsOf('A-1')]).toEqual(links);
    expect(links[0]).toEqual(['Chevrolet|Damas', 'Chevrolet|Labo']);
    // Only the stock was written; no link and no catalog fit was deleted or
    // recreated.
    expect(h.db.calls).toEqual(['stock.findUnique', 'stock.update']);
    expect(h.catalog.calls).toEqual([]);
    expect(h.partOf('A-1')).toMatchObject({
      title: 'Амортизатор',
      priceUzs: '510000',
      stockQty: 5,
      inStock: true,
    });
  });

  it('without a quantity column the stored count stays — and so does a catalog count set elsewhere', async () => {
    const h = importHarness();
    await h.run([{ code: 'B-1', qty: '8' }]);
    // A count from sync-inventory or the admin inventory console.
    Object.assign(h.partOf('B-1')!, { stockQty: 3, inStock: true });

    const report = await h.run([{ code: 'B-1', price: '160000' }], {
      columns: ['code', 'name', 'unit', 'model', 'make', 'price'],
    });

    expect(report.rows[0].changes).toEqual(['price']);
    expect(h.stockOf('B-1')).toMatchObject({
      quantity: 8,
      priceUzs: '160000',
    });
    expect(h.partOf('B-1')).toMatchObject({
      stockQty: 3,
      priceUzs: '160000',
    });
  });

  it('a column the sync did not change is never rewritten: an operator’s retail price stays when only the quantity changes', async () => {
    const h = importHarness();
    await h.run([{ code: 'C-1', price: '150000', qty: '8' }]);
    h.partOf('C-1')!.priceUzs = '149000'; // admin inventory retail price

    await h.run([{ code: 'C-1', price: '150000', qty: '6' }]);

    expect(h.partOf('C-1')).toMatchObject({ priceUzs: '149000', stockQty: 6 });
  });

  it('empty vehicle cells never remove fitment or make a part universal: part_models, fits and fitment_bindings stay', async () => {
    const h = importHarness();
    await h.run([{ code: 'D-1', model: 'DAMAS-2, LABO' }]);
    h.db.state.fitmentBindings.push({
      partId: h.partOf('D-1')!.id,
      vehicleModelId: 'damas',
      nodeId: 'node-1',
    });
    const fitment = () =>
      JSON.stringify([
        h.db.state.partModels,
        h.db.state.partMakes,
        h.db.state.fitmentBindings,
        h.catalog.fits,
        h.catalog.makeFits,
      ]);
    const before = fitment();
    h.catalog.calls.length = 0;

    const report = await h.run([
      { code: 'D-1', model: '', make: '', price: '155000' },
    ]);

    expect(report.rows[0]).toMatchObject({ outcome: 'update' });
    expect(report.rows[0].notApplied).toBeUndefined(); // empty says nothing
    expect(fitment()).toBe(before);
    expect(h.catalog.calls).toEqual([]);
    expect(h.productOf('D-1')!.isUniversal).toBe(false);
    expect(h.partOf('D-1')!.isUniversal).toBe(false);
  });

  it('category columns are never read: a category set in Mator stays, an unclassified position stays unclassified', async () => {
    const h = importHarness();
    await h.run([{ code: 'E-1' }, { code: 'E-2' }]);
    h.partOf('E-1')!.categoryId = 'shock-absorbers'; // admin bulk-move
    const file = Buffer.from(
      [
        FINAL_1C_HEADER,
        'Амортизатор\tE-1\tшт.\t160000\tCHEVROLET\tCOBALT\tbrake-system\tbrake-discs\tE-1',
        'Амортизатор\tE-2\tшт.\t160000\tCHEVROLET\tCOBALT\tsuspension-and-steering\tshock-absorbers\tE-2',
      ].join('\r\n'),
      'utf-8',
    );

    const report = await h.runFile(file);

    expect(report.headers.notImported).toEqual(
      expect.arrayContaining(['category_id', 'subcategory_id']),
    );
    expect(h.partOf('E-1')!.categoryId).toBe('shock-absorbers');
    expect(h.partOf('E-2')!.categoryId).toBe('cat_uncategorized');
    expect(h.productOf('E-1')!.categoryId).toBeNull();
    expect(h.productOf('E-2')!.categoryId).toBeNull();
  });

  it('the Telegram ingest timer runs this sync only — never the classification import', () => {
    expect(IMPORT_CLI_SCRIPT).toBe('scripts/import-drivers-village.ts');
  });
});

describe('Driver’s Village sync — codes identify positions exactly', () => {
  it('accepts "SCT SB 061-0868": stored verbatim, found again by its exact code', async () => {
    const h = importHarness();
    const first = await h.run([{ code: 'SCT SB 061-0868', price: '45000' }]);
    expect(first.rows[0]).toMatchObject({ outcome: 'create', issues: [] });
    const id = h.stockOf('SCT SB 061-0868')!.id;
    expect(h.productOf('SCT SB 061-0868')).toMatchObject({
      sourcePartNumber: 'SCT SB 061-0868',
      oemNumbers: ['SCTSB0610868'],
    });

    const again = await h.run([{ code: 'SCT SB 061-0868', price: '47000' }]);

    expect(again.rows[0]).toMatchObject({
      outcome: 'update',
      changes: ['price'],
    });
    expect(h.stockOf('SCT SB 061-0868')).toMatchObject({
      id,
      priceUzs: '47000',
    });
    expect(h.db.state.stocks).toHaveLength(1);
  });

  it('placeholders and an empty code are refused by their own rules; nothing is written', async () => {
    const h = importHarness();
    const report = await h.run([
      { code: '3333' },
      { code: '3333333' },
      { code: '' },
      { code: '   ' },
    ]);
    const reasons = report.rows.map((r) =>
      r.issues.filter((i) => i.severity === 'error').map((i) => i.code),
    );
    expect(reasons).toEqual([
      ['placeholder_code_1c'],
      ['placeholder_code_1c'],
      ['empty_code_1c'],
      ['empty_code_1c'],
    ]);
    expect(report.summary.rejectedRows).toBe(4);
    expect(h.db.state.stocks).toHaveLength(0);
  });

  it('a product name or a malformed code is refused with its reason', async () => {
    const h = importHarness();
    const report = await h.run([
      { code: 'Фильтр топливного насоса' },
      { code: '847GPUMPT   90231' },
      { code: 'RXA06820 ,' },
    ]);
    expect(
      report.rows.map(
        (r) => r.issues.find((i) => i.severity === 'error')!.code,
      ),
    ).toEqual(['name_as_code_1c', 'invalid_code_1c', 'invalid_code_1c']);
    expect(h.db.state.stocks).toHaveLength(0);
  });

  it('codes that normalize alike never merge: "PFA 235", "PFA 235-", "PFA-235" are three positions, the shared search number reported', async () => {
    const h = importHarness();
    const report = await h.run([
      { code: 'PFA 235', price: '45000' },
      { code: 'PFA 235-', price: '46000' },
      { code: 'PFA-235', price: '47000' },
    ]);

    expect(report.summary.rowsToCreate).toBe(3);
    expect(report.rows.map((r) => r.issues.map((i) => i.code)).flat()).toEqual([
      'oem_index_shared',
      'oem_index_shared',
      'oem_index_shared',
    ]);
    expect(
      ['PFA 235', 'PFA 235-', 'PFA-235'].map((c) => h.stockOf(c)!.priceUzs),
    ).toEqual(['45000', '46000', '47000']);

    // Each code keeps finding its own position only.
    await h.run([
      { code: 'PFA 235', price: '45000' },
      { code: 'PFA 235-', price: '49000' },
      { code: 'PFA-235', price: '47000' },
    ]);
    expect(
      ['PFA 235', 'PFA 235-', 'PFA-235'].map((c) => h.stockOf(c)!.priceUzs),
    ).toEqual(['45000', '49000', '47000']);
    expect(h.db.state.stocks).toHaveLength(3);
  });
});

describe('Driver’s Village sync — a repeated code_1c loses no vehicle', () => {
  it('a new position gets the vehicles of every row of its code, not only of the row with the highest price', async () => {
    const h = importHarness();
    const report = await h.run([
      { code: 'R-1', price: '500000', model: 'COBALT, GENTRA' },
      { code: 'R-1', price: '700000', model: 'COBALT' },
      { code: 'R-2', price: '900000', model: '', make: 'CHEVROLET' },
      { code: 'R-2', price: '800000', model: 'MATIZ' },
    ]);

    expect(report.duplicates.map((d) => [d.code1c, d.chosenLine])).toEqual([
      ['R-1', 3],
      ['R-2', 4],
    ]);
    expect(h.stockOf('R-1')!.priceUzs).toBe('700000');
    expect(h.modelsOf('R-1')).toEqual(['Chevrolet|Cobalt', 'Chevrolet|Gentra']);
    expect(h.fitsOf('R-1')).toEqual([
      'model_chevrolet_cobalt',
      'model_chevrolet_gentra',
    ]);
    expect(h.modelsOf('R-2')).toEqual(['Chevrolet|Matiz']);
    expect(h.catalog.makeFits.map((f) => f.makeSlug)).toEqual([
      'make_chevrolet',
    ]);
    expect(
      report.rows
        .find((r) => r.line === 3)!
        .issues.find((i) => i.code === 'duplicate_code_1c')!.message,
    ).toMatch(/vehicles of all its rows are merged/);
  });
});
