import {
  driversVillageFixture,
  FakeDb,
  FakeDriversVillageStore,
  FakeProjector,
} from '../../../test/utils/drivers-village-fake-db';
import { DriversVillageImportService } from './drivers-village-import.service';

const HEADER =
  'code_1c\tname\tmanufacturer_part_number\tquantity\tunit\tvehicle_model\tprice\tvehicle_make\tcategory_id\tsubcategory_id';

/** One row in the CURRENT export's column order. */
function row(r: {
  code: string;
  name?: string;
  oem?: string;
  qty?: string;
  unit?: string;
  model?: string;
  price?: string;
  make?: string;
  cat?: string;
  sub?: string;
}): string {
  return [
    r.code,
    r.name ?? 'Амортизатор передний',
    r.oem ?? '',
    r.qty ?? '8',
    r.unit ?? 'шт.',
    r.model ?? 'DAMAS-2',
    r.price ?? '490 000,00',
    r.make ?? 'CHEVROLET',
    r.cat ?? 'suspension-and-steering',
    r.sub ?? 'shock-absorbers',
  ].join('\t');
}
const file = (...rows: string[]) =>
  Buffer.from([HEADER, ...rows].join('\r'), 'utf-8');

const BASE = [
  row({ code: '00-00001431', oem: '96611630' }),
  row({
    code: 'БП-01071006',
    name: 'Стартер',
    model: 'MALIBU-2; TRACKER-1; MALIBU-1,5-TURBO',
    price: '2 031 708,59',
    qty: '2',
  }),
  row({
    code: 'БП-01074051',
    name: 'Тормозной диск перед',
    model: '',
    make: 'SKODA',
    cat: 'brake-system',
    sub: 'front-brake-pads',
  }),
  row({
    code: '00-00021040',
    name: 'Масло моторное 0W-20',
    model: '',
    make: '',
    qty: '64',
    unit: 'л',
    cat: 'motor-oil',
    sub: 'synthetic-motor-oil',
  }),
  row({
    code: 'БП-01068224',
    name: 'Колодки',
    oem: '96273708 s4510017  S4510017 96273708',
    cat: 'brake-system',
    sub: 'front-brake-pads',
  }),
];

function setup(
  opts: { fixture?: boolean; schemaReady?: boolean; failOnCode?: string } = {},
) {
  const db = new FakeDb(opts.fixture === false ? {} : driversVillageFixture());
  const store = new FakeDriversVillageStore(db, {
    schemaReady: opts.schemaReady,
    failOnCode: opts.failOnCode,
  });
  const projector = new FakeProjector(db);
  const service = new DriversVillageImportService(store, projector);
  return { db, store, projector, service };
}

const stockOf = (db: FakeDb, code: string) =>
  db.state.stocks.find((s) => s.sourceCode === code)!;
const productOf = (db: FakeDb, code: string) =>
  db.state.products.find((p) => p.id === stockOf(db, code).productId)!;

describe('DriversVillageImportService', () => {
  it('first import creates one product + one stock per code_1c, owned by the linked drivers-village seller', async () => {
    const { db, service, projector } = setup();
    const report = await service.run(file(...BASE), 'dv.txt', {
      dryRun: false,
    });

    expect(report.meta.aborted).toBe(false);
    expect(report.summary).toMatchObject({
      totalRows: 5,
      rowsToCreate: 5,
      rejectedRows: 0,
      blockedRows: 0,
    });
    expect(report.summary.written).toMatchObject({
      created: 5,
      updated: 0,
      projected: 5,
      projectionFailures: 0,
    });
    expect(db.state.products).toHaveLength(5);
    expect(db.state.stocks).toHaveLength(5);
    expect(db.state.sellers).toHaveLength(1); // never creates a seller
    for (const s of db.state.stocks) {
      expect(s).toMatchObject({
        sellerId: 7,
        sourceSystem: 'DRIVERS_VILLAGE_1C',
      });
    }
    expect(projector.projected.sort()).toEqual(
      db.state.stocks.map((s) => s.id).sort(),
    );

    const shock = stockOf(db, '00-00001431');
    expect(shock).toMatchObject({
      priceUzs: '490000',
      quantity: 8,
      unit: 'PCS',
    });
    // code_1c is the stock identity — never the product's GM key.
    expect(productOf(db, '00-00001431')).toMatchObject({
      gmNumber: null,
      gmNumbers: [],
      oemNumbers: ['96611630'],
      partNumberType: 'OEM',
      isOem: true,
      isGm: false,
      categoryId: 'shock-absorbers',
      vehicleCategoryId: 'suspension-and-steering',
      isUniversal: false,
      kind: 'SPARE_PART',
    });
    expect(stockOf(db, '00-00021040')).toMatchObject({
      quantity: 64,
      unit: 'L',
    });
  });

  it('carries category/subcategory through as approved ids (subcategory → categoryId, root → vehicleCategoryId)', async () => {
    const { db, service } = setup();
    await service.run(file(...BASE), 'dv.txt', { dryRun: false });
    expect(productOf(db, '00-00021040')).toMatchObject({
      categoryId: 'synthetic-motor-oil',
      vehicleCategoryId: 'motor-oil',
    });
    expect(productOf(db, 'БП-01074051')).toMatchObject({
      categoryId: 'front-brake-pads',
      vehicleCategoryId: 'brake-system',
      vehicleCategory: 'BRAKE_SYSTEM',
    });
  });

  it('writes the three vehicle states: specific models (split on ;), make-wide, universal', async () => {
    const { db, service } = setup();
    await service.run(file(...BASE), 'dv.txt', { dryRun: false });
    const st = db.state;
    const modelsOf = (code: string) =>
      st.partModels
        .filter((pm) => pm.partId === productOf(db, code).id)
        .map((pm) => st.carModels.find((m) => m.id === pm.modelId)!.name)
        .sort();

    expect(modelsOf('00-00001431')).toEqual(['Damas']);
    // MALIBU-2 and MALIBU-1,5-TURBO both resolve to Malibu → one link, no duplicate.
    expect(modelsOf('БП-01071006')).toEqual(['Malibu', 'Tracker']);
    // Make-wide: no model links, one make link, not universal.
    expect(modelsOf('БП-01074051')).toEqual([]);
    expect(
      st.partMakes.filter((m) => m.partId === productOf(db, 'БП-01074051').id),
    ).toHaveLength(1);
    expect(productOf(db, 'БП-01074051').isUniversal).toBe(false);
    // Global universal: nothing linked, isUniversal.
    expect(productOf(db, '00-00021040').isUniversal).toBe(true);
    expect(modelsOf('00-00021040')).toEqual([]);
  });

  it('normalizes and de-duplicates OEM values', async () => {
    const { db, service } = setup();
    await service.run(file(...BASE), 'dv.txt', { dryRun: false });
    expect(productOf(db, 'БП-01068224').oemNumbers).toEqual([
      '96273708',
      'S4510017',
    ]);
  });

  it('second import with a new price/quantity updates the SAME stock and product', async () => {
    const { db, service } = setup();
    await service.run(file(...BASE), 'dv.txt', { dryRun: false });
    const before = {
      stock: stockOf(db, '00-00001431').id,
      product: productOf(db, '00-00001431').id,
    };

    const changed = [
      row({
        code: '00-00001431',
        oem: '96611630',
        price: '510 000,00',
        qty: '5',
      }),
      ...BASE.slice(1),
    ];
    const report = await service.run(file(...changed), 'dv.txt', {
      dryRun: false,
    });

    expect(report.summary).toMatchObject({
      rowsToUpdate: 1,
      rowsUnchanged: 4,
      rowsToCreate: 0,
    });
    const r = report.rows.find((x) => x.code1c === '00-00001431')!;
    expect(r).toMatchObject({
      outcome: 'update',
      changes: ['price', 'quantity'],
      written: 'updated',
    });
    expect(r.price).toEqual({ from: '490000', to: '510000.00' });
    expect(stockOf(db, '00-00001431')).toMatchObject({
      id: before.stock,
      productId: before.product,
      priceUzs: '510000',
      quantity: 5,
    });
    expect(db.state.stocks).toHaveLength(5);
    expect(db.state.products).toHaveLength(5);
  });

  it('repeated identical import is a no-op: nothing rewritten, no duplicates of anything', async () => {
    const { db, store, service } = setup();
    await service.run(file(...BASE), 'dv.txt', { dryRun: false });
    const snapshot = JSON.stringify(db.state);
    const callsBefore = store.applyBatchCalls;

    const report = await service.run(file(...BASE), 'dv.txt', {
      dryRun: false,
    });
    expect(report.summary).toMatchObject({
      rowsUnchanged: 5,
      rowsToCreate: 0,
      rowsToUpdate: 0,
    });
    expect(report.summary.written).toMatchObject({
      skippedUnchanged: 5,
      created: 0,
      updated: 0,
    });
    expect(store.applyBatchCalls).toBe(callsBefore);
    expect(JSON.stringify(db.state)).toBe(snapshot);
  });

  it('re-import never deletes or changes product photos', async () => {
    const { db, service } = setup();
    await service.run(file(...BASE), 'dv.txt', { dryRun: false });
    const p = productOf(db, '00-00001431');
    db.state.productImages.push(
      { productId: p.id, url: 'https://img/1.jpg' },
      { productId: p.id, url: 'https://img/2.jpg' },
    );
    p.imageUrl = 'https://img/1.jpg';

    const changed = [
      row({
        code: '00-00001431',
        name: 'Амортизатор RH',
        oem: '96611630',
        price: '1,00',
        model: 'COBALT',
      }),
      ...BASE.slice(1),
    ];
    const report = await service.run(file(...changed), 'dv.txt', {
      dryRun: false,
    });

    expect(report.summary.existingPositionsWithPhotos).toBe(1);
    expect(
      db.state.productImages.filter((i) => i.productId === p.id),
    ).toHaveLength(2);
    expect(productOf(db, '00-00001431')).toMatchObject({
      title: 'Амортизатор RH',
      imageUrl: 'https://img/1.jpg',
    });
  });

  it('dry-run performs every check but zero writes', async () => {
    const { db, store, projector, service } = setup();
    const before = JSON.stringify(db.state);
    const report = await service.run(file(...BASE), 'dv.txt', { dryRun: true });

    expect(report.meta.mode).toBe('dry-run');
    expect(report.summary).toMatchObject({
      totalRows: 5,
      rowsToCreate: 5,
      written: null,
    });
    expect(store.applyBatchCalls).toBe(0);
    expect(projector.projected).toEqual([]);
    expect(db.calls).toEqual([]);
    expect(JSON.stringify(db.state)).toBe(before);
  });

  it('rejects every occurrence of a duplicate code_1c', async () => {
    const { db, service } = setup();
    const report = await service.run(
      file(BASE[0], row({ code: '00-00001431', price: '1,00' }), BASE[1]),
      'dv.txt',
      { dryRun: false },
    );
    expect(report.summary).toMatchObject({
      duplicateSourceCodes: 1,
      rejectedRows: 2,
    });
    expect(
      report.rows.filter((r) =>
        r.issues.some((i) => i.code === 'duplicate_code_1c'),
      ),
    ).toHaveLength(2);
    expect(db.state.stocks.map((s) => s.sourceCode)).toEqual(['БП-01071006']);
  });

  it('always targets the drivers-village dealer and reports a missing link as ENVIRONMENT, not data', async () => {
    const { db, store, service } = setup({ fixture: false });
    const find = jest.spyOn(store, 'findCatalogSeller');
    const linked = jest.spyOn(store, 'findLinkedSeller');

    const dry = await service.run(file(...BASE), 'dv.txt', { dryRun: true });
    expect(find).toHaveBeenCalledWith('drivers-village');
    expect(linked).toHaveBeenCalledWith('drivers-village');
    expect(dry.environment.issues.map((i) => i.code)).toEqual([
      'catalog_seller_missing',
      'linked_seller_missing',
    ]);
    expect(dry.environment.issues.every((i) => i.kind === 'reference')).toBe(
      true,
    );
    expect(dry.summary.dataErrors).toBe(0);

    const real = await service.run(file(...BASE), 'dv.txt', { dryRun: false });
    expect(real.meta.aborted).toBe(true);
    expect(db.state.stocks).toHaveLength(0);
    expect(db.state.sellers).toHaveLength(0);
  });

  it('a category missing from this database blocks only that row, as a reference issue', async () => {
    const { db, service } = setup();
    const report = await service.run(
      file(BASE[0], row({ code: 'X-1', sub: 'remote-keys' })),
      'dv.txt',
      { dryRun: false },
    );
    const blocked = report.rows.find((r) => r.code1c === 'X-1')!;
    expect(blocked.outcome).toBe('blocked');
    expect(blocked.issues).toEqual([
      expect.objectContaining({
        kind: 'reference',
        code: 'subcategory_not_in_database',
      }),
    ]);
    expect(report.environment.missingCategoryIds).toEqual(['remote-keys']);
    expect(report.summary).toMatchObject({
      dataErrors: 0,
      referenceErrors: 1,
      blockedRows: 1,
    });
    expect(db.state.stocks.map((s) => s.sourceCode)).toEqual(['00-00001431']);
  });

  it('reports an unmigrated database as an environment issue instead of failing', async () => {
    const { service } = setup({ schemaReady: false });
    const report = await service.run(file(...BASE), 'dv.txt', { dryRun: true });
    expect(report.environment.issues.map((i) => i.code)).toContain(
      'schema_not_migrated',
    );
    expect(report.summary.rowsToCreate).toBe(5);
  });

  it('a failed batch rolls back alone; re-running resumes without duplicates', async () => {
    const first = setup({ failOnCode: 'БП-01074051' });
    const report = await first.service.run(file(...BASE), 'dv.txt', {
      dryRun: false,
      batchSize: 2,
    });
    expect(report.meta.aborted).toBe(true);
    // Batch 1 (2 rows) committed; batch 2 (rows 3–4) rolled back entirely.
    expect(first.db.state.stocks.map((s) => s.sourceCode).sort()).toEqual(
      ['00-00001431', 'БП-01071006'].sort(),
    );

    const resumed = new DriversVillageImportService(
      new FakeDriversVillageStore(first.db),
      new FakeProjector(first.db),
    );
    const again = await resumed.run(file(...BASE), 'dv.txt', {
      dryRun: false,
      batchSize: 2,
    });
    expect(again.meta.aborted).toBe(false);
    expect(again.summary).toMatchObject({ rowsUnchanged: 2, rowsToCreate: 3 });
    expect(first.db.state.stocks).toHaveLength(5);
    expect(first.db.state.products).toHaveLength(5);
  });

  it('re-projects an unchanged position whose catalog projection is missing', async () => {
    const { db, service } = setup();
    await service.run(file(BASE[0]), 'dv.txt', { dryRun: false });
    db.state.catalogParts = [];
    const report = await service.run(file(BASE[0]), 'dv.txt', {
      dryRun: false,
    });
    expect(report.summary.written).toMatchObject({
      skippedUnchanged: 1,
      projected: 1,
    });
    expect(db.state.catalogParts).toEqual([
      `part_stock_${stockOf(db, '00-00001431').id}`,
    ]);
  });

  it('reports DB positions absent from the file without touching them', async () => {
    const { db, service } = setup();
    await service.run(file(...BASE), 'dv.txt', { dryRun: false });
    const report = await service.run(file(BASE[0]), 'dv.txt', {
      dryRun: false,
    });
    expect(report.positionsNotInFile).toHaveLength(4);
    expect(db.state.stocks).toHaveLength(5);
  });

  it('aborts on oversize input and a missing required column before any write', async () => {
    const { store, service } = setup();
    const noPrice = Buffer.from(
      'code_1c\tname\tquantity\tunit\tvehicle_model\tvehicle_make\tcategory_id\tsubcategory_id\rA\tB\t1\tшт.\t\t\tx\ty',
      'utf-8',
    );
    const report = await service.run(noPrice, 'dv.txt', { dryRun: false });
    expect(report.meta.aborted).toBe(true);
    expect(report.meta.abortReason).toMatch(/Missing required column: price/);
    expect(store.applyBatchCalls).toBe(0);

    const huge = await service.run(
      new Uint8Array(21 * 1024 * 1024),
      'big.txt',
      { dryRun: true },
    );
    expect(huge.meta.abortReason).toMatch(/limit/);
  });
});

describe('DriversVillageImportService — seller setup and price exactness', () => {
  it('writes the source price exactly, end to end', async () => {
    const { db, service } = setup();
    const report = await service.run(
      file(
        row({ code: 'P-1', price: '195 642,86' }),
        row({ code: 'P-2', price: '13 335 610,00' }),
      ),
      'dv.txt',
      { dryRun: false },
    );
    expect(report.rows.map((r) => r.price?.to)).toEqual([
      '195642.86',
      '13335610.00',
    ]);
    expect(db.state.stocks.map((s) => s.priceUzs)).toEqual([
      '195642.86',
      '13335610',
    ]);
  });

  it('fails with a clear setup error when no business seller is linked, and writes nothing', async () => {
    const db = new FakeDb({ ...driversVillageFixture(), sellers: [] });
    const service = new DriversVillageImportService(
      new FakeDriversVillageStore(db),
      new FakeProjector(db),
    );

    const report = await service.run(file(...BASE), 'dv.txt', {
      dryRun: false,
    });

    expect(report.meta.aborted).toBe(true);
    expect(report.meta.abortReason).toMatch(
      /^Setup error — nothing was written: Setup required: no supply-side seller is linked to catalog seller "drivers-village"/,
    );
    expect(report.meta.abortReason).toMatch(
      /BUSINESS seller \(tg_id NULL\).*DRIVERS_VILLAGE_IMPORT\.md §1/,
    );
    expect(db.state.stocks).toHaveLength(0);
    expect(db.state.sellers).toHaveLength(0); // never creates one
  });

  it('refuses a TELEGRAM seller linked to the dealer', async () => {
    const db = new FakeDb({
      ...driversVillageFixture(),
      sellers: [
        {
          id: 3,
          sellerType: 'TELEGRAM',
          tgId: BigInt(42),
          status: 'ACTIVE',
          catalogSellerId: 'drivers-village',
        },
      ],
    });
    const service = new DriversVillageImportService(
      new FakeDriversVillageStore(db),
      new FakeProjector(db),
    );

    const dry = await service.run(file(...BASE), 'dv.txt', { dryRun: true });
    expect(dry.environment).toMatchObject({
      linkedSellerId: 3,
      linkedSellerType: 'TELEGRAM',
    });
    expect(dry.environment.issues.map((i) => i.code)).toEqual([
      'linked_seller_not_business',
    ]);

    const real = await service.run(file(...BASE), 'dv.txt', { dryRun: false });
    expect(real.meta.aborted).toBe(true);
    expect(db.state.stocks).toHaveLength(0);
  });

  it('imports for the BUSINESS seller and only warns when it is not ACTIVE', async () => {
    const db = new FakeDb(driversVillageFixture());
    db.state.sellers[0].status = 'PENDING';
    const service = new DriversVillageImportService(
      new FakeDriversVillageStore(db),
      new FakeProjector(db),
    );

    const report = await service.run(file(BASE[0]), 'dv.txt', {
      dryRun: false,
    });

    expect(report.environment.issues).toEqual([
      expect.objectContaining({
        code: 'linked_seller_not_active',
        severity: 'warning',
      }),
    ]);
    expect(report.environment.linkedSellerType).toBe('BUSINESS');
    expect(report.meta.aborted).toBe(false);
    expect(db.state.stocks).toEqual([
      expect.objectContaining({ sellerId: 7, sourceCode: '00-00001431' }),
    ]);
  });
});
