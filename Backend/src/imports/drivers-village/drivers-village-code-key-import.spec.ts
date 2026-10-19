/**
 * A changed code_1c found by its 8-digit key, end to end — the real importer
 * and the REAL Stock → CatalogPart projection over the in-memory fakes
 * (test/utils/drivers-village-import-harness.ts). Synthetic rows only, no
 * database. Ambiguous keys: drivers-village-code-key-ambiguity.spec.ts; the
 * OEM index and the buyer search: drivers-village-code-key-search.spec.ts.
 */
import {
  importHarness,
  type Cells,
} from '../../../test/utils/drivers-village-import-harness';

describe('Driver’s Village — a changed code_1c found by its 8-digit key', () => {
  it('`96273708 GMB` updates the position imported as `96273708`: same ids, no second product', async () => {
    const { db, run, stockOf, productOf, partOf } = importHarness();
    await run([{ code: '96273708', qty: '8' }]);
    const ids = {
      stock: stockOf('96273708')!.id,
      product: productOf('96273708')!.id,
    };

    const report = await run([
      {
        code: '96273708 GMB',
        name: 'Фильтр масляный GMB',
        price: '165000',
        qty: '5',
      },
    ]);

    expect(report.summary).toMatchObject({
      rowsToCreate: 0,
      rowsToUpdate: 1,
      rowsMatchedByKey: 1,
      keyConflicts: 0,
      rowsToCreateWithSharedKey: 0,
      positionsNotInFile: 0,
    });
    expect(report.keyMatches).toEqual([
      {
        key: '96273708',
        line: 2,
        code1c: '96273708 GMB',
        storedCode: '96273708',
        stockId: ids.stock,
      },
    ]);
    expect(report.rows[0]).toMatchObject({
      outcome: 'update',
      written: 'updated',
      changes: [
        'price',
        'quantity',
        'name',
        'source_code',
        'part_number',
        'oem_numbers',
      ],
      partNumber: { from: '96273708', to: '96273708 GMB' },
      price: { to: '165000.00' },
      quantity: { from: 8, to: 5 },
    });
    expect(Number(report.rows[0].price!.from)).toBe(150000);
    expect(report.rows[0].issues.map((i) => [i.code, i.severity])).toEqual([
      ['code_key_match', 'warning'],
    ]);
    // code_1c verbatim, suffix kept: the stock's code and the part number. The
    // index keeps the stored 96273708 next to the new code's own entry.
    expect(stockOf('96273708')).toBeUndefined();
    expect(stockOf('96273708 GMB')).toMatchObject({
      id: ids.stock,
      priceUzs: '165000',
      quantity: 5,
    });
    expect(productOf('96273708 GMB')).toMatchObject({
      id: ids.product,
      title: 'Фильтр масляный GMB',
      sourcePartNumber: '96273708 GMB',
      oemNumbers: ['96273708GMB', '96273708'],
    });
    expect(partOf('96273708 GMB')).toMatchObject({
      id: `part_stock_${ids.stock}`,
      priceUzs: '165000',
      oemNumbers: ['96273708GMB', '96273708'],
    });
    expect(db.state.stocks).toHaveLength(1);
    expect(db.state.products).toHaveLength(1);
    expect(db.state.catalogParts).toHaveLength(1);
  });

  it('everything the import does not own survives the match: photos, category, description, rating and the rest', async () => {
    const { db, run, stockOf, productOf, partOf } = importHarness();
    await run([{ code: '96273708' }]);
    const productId = productOf('96273708')!.id;
    const mator = {
      imageUrl: 'https://img/1.jpg',
      description: 'описание оператора',
      categoryId: 'oil-filters',
      vehicleCategoryId: 'engine',
      mainCategory: 'ENGINE_PARTS',
      vehicleCategory: 'ENGINE',
      ratingAvg: '4.5',
      reviewCount: 3,
      packageForm: 'PIECE',
      partBrand: 'GM',
      originRegion: 'KOREA',
      kind: 'SPARE_PART',
      gmNumber: null,
    };
    Object.assign(productOf('96273708')!, mator);
    db.state.productImages.push(
      { productId, url: 'https://img/1.jpg' },
      { productId, url: 'https://img/2.jpg' },
    );
    // Written on catalog_parts by the admin console and the stock sync.
    const onPart = {
      categoryId: 'oil-filters',
      mainCategory: 'ENGINE_PARTS',
      purchasePriceUzs: '90000',
      deliveryEtaDaysMin: 2,
    };
    Object.assign(partOf('96273708')!, onPart);

    await run([{ code: '96273708 GMB', price: '165000' }]);

    expect(productOf('96273708 GMB')).toMatchObject({
      id: productId,
      ...mator,
    });
    expect(db.state.productImages).toEqual([
      { productId, url: 'https://img/1.jpg' },
      { productId, url: 'https://img/2.jpg' },
    ]);
    expect(partOf('96273708 GMB')).toMatchObject({
      ...onPart,
      images: ['https://img/1.jpg', 'https://img/2.jpg'],
      ratingAvg: '4.5',
    });
    expect(stockOf('96273708 GMB')!.sellerId).toBe(7);
  });

  it('re-importing it changes nothing: price, quantity and every field stay', async () => {
    const { db, store, run } = importHarness();
    await run([{ code: '96273708', qty: '8' }]);
    const file: Cells[] = [{ code: '96273708 GMB', price: '165000', qty: '5' }];
    await run(file);
    const snapshot = JSON.stringify(db.state);
    const batches = store.applyBatchCalls;

    const again = await run(file);

    expect(again.summary).toMatchObject({
      rowsUnchanged: 1,
      rowsToUpdate: 0,
      rowsMatchedByKey: 0,
    });
    expect(store.applyBatchCalls).toBe(batches);
    expect(JSON.stringify(db.state)).toBe(snapshot);
  });

  it('a file without quantities keeps the stored count through the match', async () => {
    const { run, stockOf } = importHarness();
    await run([{ code: '96273708', qty: '8' }]);
    const report = await run([{ code: '96273708 OEM', price: '170000' }], {
      columns: ['code', 'name', 'unit', 'model', 'make', 'price'],
    });
    expect(report.rows[0].quantity).toEqual({ from: 8, to: null });
    expect(stockOf('96273708 OEM')).toMatchObject({
      priceUzs: '170000',
      quantity: 8,
    });
  });

  it('the marker may come first, and a dropped marker finds the position too', async () => {
    const { db, run, stockOf, productOf } = importHarness();
    await run([{ code: 'GMB 96273708' }]);
    const id = stockOf('GMB 96273708')!.id;

    const report = await run([{ code: '96273708', price: '160000' }]);

    expect(report.summary.rowsMatchedByKey).toBe(1);
    expect(stockOf('96273708')).toMatchObject({ id, priceUzs: '160000' });
    expect(productOf('96273708')).toMatchObject({
      sourcePartNumber: '96273708',
      oemNumbers: ['96273708'],
    });
    expect(db.state.stocks).toHaveLength(1);
  });

  it('a repeated code is still one position at its first highest valid price, which then takes over the stored one', async () => {
    const { db, run, stockOf, productOf } = importHarness();
    await run([{ code: '96273708', qty: '8' }]);
    const report = await run([
      { code: '96273708 GMB', price: '160000', qty: '3' },
      { code: '96273708 GMB', price: '175000', qty: '4', name: 'Фильтр GMB' },
      { code: '96273708 GMB', price: '175000', qty: '9' },
    ]);
    expect(report.duplicates[0]).toMatchObject({
      code1c: '96273708 GMB',
      chosenLine: 3,
      priceUzs: '175000.00',
    });
    expect(report.rows.map((r) => r.outcome)).toEqual([
      'merged',
      'update',
      'merged',
    ]);
    expect(stockOf('96273708 GMB')).toMatchObject({
      priceUzs: '175000',
      quantity: 4,
    });
    expect(productOf('96273708 GMB')!.title).toBe('Фильтр GMB');
    expect(db.state.stocks).toHaveLength(1);
  });

  it('a code without an 8-digit key is matched exactly, as before — never through a key', async () => {
    const { db, run, stockOf, position } = importHarness();
    await run([
      { code: '5Q0-615-301-F' },
      { code: '1234567890' },
      { code: '123456789' },
    ]);
    const kept = [position('1234567890'), position('123456789')];
    const id = stockOf('5Q0-615-301-F')!.id;

    const report = await run([
      { code: '5Q0-615-301-F', price: '155000' }, // exact → updated in place
      { code: '5Q0-615-301-G' }, // no key → a new position
      { code: '1234567890-A' }, // 10 digits: no key → a new position
      { code: '123456789 GMB' }, // 9 digits: no key, so the space is invalid
    ]);

    expect(report.summary).toMatchObject({
      rowsToUpdate: 1,
      rowsToCreate: 2,
      rejectedRows: 1,
      rowsMatchedByKey: 0,
      keyConflicts: 0,
    });
    expect(report.rows[3].issues.map((i) => i.code)).toEqual([
      'invalid_code_1c',
    ]);
    expect(stockOf('5Q0-615-301-F')).toMatchObject({ id, priceUzs: '155000' });
    expect([position('1234567890'), position('123456789')]).toEqual(kept);
    expect(report.positionsNotInFile).toEqual(['123456789', '1234567890']);
    expect(db.state.stocks).toHaveLength(5);
  });

  it('only this seller’s positions are candidates', async () => {
    const { db, run, stockOf } = importHarness();
    db.state.sellers.push({
      id: 99,
      sellerType: 'BUSINESS',
      tgId: null,
      status: 'ACTIVE',
      catalogSellerId: null,
    });
    db.state.products.push({
      id: 1,
      gmNumber: null,
      title: 'Чужой фильтр',
      gmNumbers: [],
      sourcePartNumber: '96273708',
      oemNumbers: ['96273708'],
      categoryId: null,
      vehicleCategoryId: null,
      mainCategory: null,
      vehicleCategory: null,
      isUniversal: true,
      imageUrl: null,
      description: null,
    });
    const foreign = {
      id: 2,
      sellerId: 99,
      productId: 1,
      sourceSystem: 'DRIVERS_VILLAGE_1C',
      sourceCode: '96273708',
      priceUzs: '5',
      quantity: 1,
      unit: 'PCS',
    };
    db.state.stocks.push({ ...foreign });

    const report = await run([{ code: '96273708 GMB' }]);

    expect(report.summary).toMatchObject({
      rowsToCreate: 1,
      rowsMatchedByKey: 0,
    });
    expect(stockOf('96273708 GMB')!.sellerId).toBe(7);
    expect(db.state.stocks.find((s) => s.id === 2)).toEqual(foreign);
  });

  it('a failed batch rolls the match back with the rest of the batch: no partial write', async () => {
    const harness = importHarness({ failOnCode: '96273708 GMB' });
    const { db, run, position } = harness;
    await run([{ code: '96273708', qty: '8' }]);
    const before = JSON.stringify(db.state);
    const stored = position('96273708');

    const report = await run([
      { code: 'AAA-100', price: '120000' }, // written first in the same batch
      { code: '96273708 GMB', price: '165000', qty: '5' },
    ]);

    expect(report.meta.aborted).toBe(true);
    expect(report.meta.abortReason).toMatch(/rolled back/);
    expect(position('96273708')).toBe(stored);
    expect(JSON.stringify(db.state)).toBe(before);
  });
});
