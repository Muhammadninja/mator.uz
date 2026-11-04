/**
 * A code_1c that changed in 1C is found by NOTHING but its exact code — end to
 * end: the real importer and the REAL Stock → CatalogPart projection over the
 * in-memory fakes (test/utils/drivers-village-import-harness.ts). Synthetic
 * rows only, no database. Codes sharing a key:
 * drivers-village-code-key-ambiguity.spec.ts; the OEM index and the buyer
 * search: drivers-village-code-key-search.spec.ts.
 */
import {
  importHarness,
  type Cells,
} from '../../../test/utils/drivers-village-import-harness';

describe('Driver’s Village — a changed code_1c is never merged into a stored position', () => {
  it('`96273708 GMB` next to a stored `96273708`: a new position, the stored one untouched, a possible rename reported', async () => {
    const { db, run, stockOf, productOf, position } = importHarness();
    await run([{ code: '96273708', qty: '8' }]);
    const stored = position('96273708');

    const report = await run([
      {
        code: '96273708 GMB',
        name: 'Фильтр масляный GMB',
        price: '165000',
        qty: '5',
      },
    ]);

    expect(report.summary).toMatchObject({
      rowsToCreate: 1,
      rowsToUpdate: 0,
      rowsToCreateWithSharedKey: 1,
      rowsWithPossibleRename: 1,
      positionsNotInFile: 1,
    });
    expect(report.keyShared).toEqual([
      {
        key: '96273708',
        line: 2,
        code1c: '96273708 GMB',
        fileCodes: [],
        storedCodes: ['96273708'],
        possibleRenameOf: ['96273708'],
      },
    ]);
    expect(report.rows[0]).toMatchObject({
      outcome: 'create',
      written: 'created',
    });
    expect(
      report.rows[0].issues.find((i) => i.code === 'code_key_shared')!.message,
    ).toMatch(/possibly "96273708" renamed in 1C.*never renames or merges/);
    expect(position('96273708')).toBe(stored);
    expect(stockOf('96273708 GMB')).toMatchObject({
      priceUzs: '165000',
      quantity: 5,
    });
    expect(productOf('96273708 GMB')).toMatchObject({
      title: 'Фильтр масляный GMB',
      sourcePartNumber: '96273708 GMB',
    });
    expect(productOf('96273708 GMB')!.id).not.toBe(productOf('96273708')!.id);
    expect(db.state.stocks).toHaveLength(2);
  });

  it('a marker that is another brand never takes a stored price: `96273708PMC(EU)`, `94583379S&T`', async () => {
    const { run, stockOf, position } = importHarness();
    await run([
      { code: '96273708', price: '300000' },
      { code: '94583379', price: '410000' },
    ]);
    const stored = [position('96273708'), position('94583379')];

    await run([
      { code: '96273708PMC(EU)', price: '120000' },
      { code: '94583379S&T', price: '180000' },
    ]);

    expect([position('96273708'), position('94583379')]).toEqual(stored);
    expect(stockOf('96273708PMC(EU)')!.priceUzs).toBe('120000');
    expect(stockOf('94583379S&T')!.priceUzs).toBe('180000');
  });

  it('re-importing it changes nothing: no second position, nothing rewritten', async () => {
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
      rowsToCreate: 0,
    });
    expect(again.keyShared).toEqual([]); // it has a position of its own now
    expect(store.applyBatchCalls).toBe(batches);
    expect(JSON.stringify(db.state)).toBe(snapshot);
  });

  it('the marker may come first, or be dropped: still separate positions', async () => {
    const { db, run, stockOf, position } = importHarness();
    await run([{ code: 'GMB 96273708', price: '170000' }]);
    const stored = position('GMB 96273708');

    const report = await run([{ code: '96273708', price: '160000' }]);

    expect(report.keyShared[0].possibleRenameOf).toEqual(['GMB 96273708']);
    expect(position('GMB 96273708')).toBe(stored);
    expect(stockOf('96273708')!.priceUzs).toBe('160000');
    expect(db.state.stocks).toHaveLength(2);
  });

  it('a code is matched exactly — a stored code never answers for another one', async () => {
    const { db, run, stockOf, position } = importHarness();
    await run([
      { code: '5Q0-615-301-F' },
      { code: '1234567890' },
      { code: '123456789' },
    ]);
    const kept = [position('1234567890'), position('123456789')];
    const id = stockOf('5Q0-615-301-F')!.id;

    const report = await run([
      { code: '5Q0-615-301-F', price: '155000' }, // exact → synced in place
      { code: '5Q0-615-301-G' }, // a new position
      { code: '1234567890-A' }, // a new position
      { code: '123456789 GMB' }, // an article of two tokens: a new position
    ]);

    expect(report.summary).toMatchObject({
      rowsToUpdate: 1,
      rowsToCreate: 3,
      rejectedRows: 0,
    });
    expect(stockOf('5Q0-615-301-F')).toMatchObject({ id, priceUzs: '155000' });
    expect([position('1234567890'), position('123456789')]).toEqual(kept);
    expect(report.positionsNotInFile).toEqual(['123456789', '1234567890']);
    expect(db.state.stocks).toHaveLength(6);
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

    // The same exact code under another seller is not this seller's position.
    const report = await run([{ code: '96273708' }, { code: '96273708 GMB' }]);

    expect(report.summary).toMatchObject({ rowsToCreate: 2, rowsToUpdate: 0 });
    expect(stockOf('96273708 GMB')!.sellerId).toBe(7);
    expect(
      db.state.stocks.filter((s) => s.sourceCode === '96273708'),
    ).toHaveLength(2);
    expect(db.state.stocks.find((s) => s.id === 2)).toEqual(foreign);
  });

  it('a failed batch rolls back with the rest of the batch: no partial write', async () => {
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
