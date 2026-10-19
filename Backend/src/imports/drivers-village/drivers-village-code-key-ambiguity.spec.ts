/**
 * Codes that share an 8-digit key — several in one file, several stored — end
 * to end (the real importer and projection over the in-memory fakes,
 * synthetic rows, no database). Each code is a position of its own; the key
 * never makes one code write another code's position. It is only reported.
 */
import { importHarness } from '../../../test/utils/drivers-village-import-harness';

describe('Driver’s Village — codes sharing an 8-digit key are separate positions', () => {
  it.each([
    ['a replaced marker', '96273708 GMB', '96273708 OEM', '96273708'],
    ['another 1C series', '00-00001431', 'БП-00001431', '00001431'],
  ])(
    '%s (%s → %s): a new position of its own; the stored one stays exactly as it is',
    async (_case, storedCode, newCode, key) => {
      const { db, run, stockOf, productOf, position } = importHarness();
      await run([{ code: storedCode, qty: '8' }]);
      const stored = position(storedCode);

      const report = await run([{ code: newCode, price: '170000', qty: '2' }]);

      expect(report.summary).toMatchObject({
        rowsToCreate: 1,
        rowsToUpdate: 0,
        rowsToCreateWithSharedKey: 1,
        rowsWithPossibleRename: 0,
        positionsNotInFile: 1,
      });
      expect(report.keyShared).toEqual([
        {
          key,
          line: 2,
          code1c: newCode,
          fileCodes: [],
          storedCodes: [storedCode],
          possibleRenameOf: [],
        },
      ]);
      expect(report.rows[0]).toMatchObject({
        outcome: 'create',
        written: 'created',
      });
      expect(position(storedCode)).toBe(stored);
      expect(stockOf(newCode)).toMatchObject({
        priceUzs: '170000',
        quantity: 2,
      });
      expect(productOf(newCode)!.id).not.toBe(productOf(storedCode)!.id);
      expect(db.state.stocks).toHaveLength(2);
    },
  );

  it('several stored positions with the key: a position of its own, none of them changes', async () => {
    const { db, run, stockOf, position } = importHarness();
    await run([
      { code: '96273708' },
      { code: '96273708-HN', name: 'Фильтр масляный Heinner', price: '90000' },
    ]);
    db.state.productImages.push({
      productId: stockOf('96273708')!.productId,
      url: 'https://img/1.jpg',
    });
    const before = [position('96273708'), position('96273708-HN')];

    const report = await run([
      { code: '96273708 OEM', price: '170000' },
      { code: '96350526', name: 'Амортизатор', price: '520000' },
    ]);

    expect(report.keyShared[0]).toMatchObject({
      code1c: '96273708 OEM',
      storedCodes: ['96273708', '96273708-HN'],
      possibleRenameOf: ['96273708'],
    });
    expect(report.summary).toMatchObject({
      rowsToCreate: 2,
      rowsToCreateWithSharedKey: 1,
    });
    // Stock, product, catalog part, fitment links and photos: untouched.
    expect([position('96273708'), position('96273708-HN')]).toEqual(before);
    expect(stockOf('96273708 OEM')!.priceUzs).toBe('170000');
    expect(db.state.stocks).toHaveLength(4);
  });

  it('two codes of one file with the key of one stored position: two new positions, nothing merged', async () => {
    const { db, run, position } = importHarness();
    await run([{ code: '96273708', qty: '8' }]);
    const before = position('96273708');

    const report = await run([
      { code: '96273708 GMB', price: '165000', qty: '5' },
      { code: '96273708 OEM', price: '190000', qty: '2' },
    ]);

    expect(report.rows.map((r) => r.outcome)).toEqual(['create', 'create']);
    expect(report.keyShared.map((k) => [k.code1c, k.fileCodes])).toEqual([
      ['96273708 GMB', ['96273708 OEM']],
      ['96273708 OEM', ['96273708 GMB']],
    ]);
    expect(position('96273708')).toBe(before);
    expect(db.state.stocks).toHaveLength(3);
  });

  it('an exact code still updates its own position while others share its key', async () => {
    const { run, stockOf, position } = importHarness();
    await run([{ code: '96273708' }, { code: '96273708-HN', price: '90000' }]);
    const other = position('96273708-HN');

    const report = await run([{ code: '96273708', price: '155000' }]);

    expect(report.rows[0]).toMatchObject({
      outcome: 'update',
      changes: ['price'],
    });
    expect(stockOf('96273708')!.priceUzs).toBe('155000');
    expect(position('96273708-HN')).toBe(other);
  });

  it('codes of one file sharing a key: reported, counted, never merged — later each updates its own', async () => {
    const { db, run, stockOf } = importHarness();
    const report = await run([
      { code: '96273708', price: '150000', qty: '8' },
      { code: '96273708 GMB', price: '165000', qty: '5' },
      { code: 'X-1', price: '120000' },
    ]);

    expect(report.summary).toMatchObject({
      rowsToCreate: 3,
      rowsToCreateWithSharedKey: 2,
      rowsMerged: 0,
    });
    expect(report.keyShared.map((k) => [k.code1c, k.fileCodes])).toEqual([
      ['96273708', ['96273708 GMB']],
      ['96273708 GMB', ['96273708']],
    ]);
    expect(stockOf('96273708')).toMatchObject({
      priceUzs: '150000',
      quantity: 8,
    });
    expect(stockOf('96273708 GMB')).toMatchObject({
      priceUzs: '165000',
      quantity: 5,
    });
    expect(db.state.products).toHaveLength(3);

    const next = await run([
      { code: '96273708', price: '151000', qty: '8' },
      { code: '96273708 GMB', price: '166000', qty: '5' },
    ]);
    expect(next.summary).toMatchObject({
      rowsToUpdate: 2,
      rowsToCreateWithSharedKey: 0,
    });
    expect(next.keyShared).toEqual([]);
    expect(db.state.stocks).toHaveLength(3);
  });

  it('a new code next to an exact one: its own position, the exact one updated in place', async () => {
    const { db, run, stockOf } = importHarness();
    await run([{ code: '96273708', qty: '8' }]);
    const id = stockOf('96273708')!.id;

    const report = await run([
      { code: '96273708', price: '155000' },
      { code: '96273708 GMB', price: '165000' },
    ]);

    expect(report.rows.map((r) => r.outcome)).toEqual(['update', 'create']);
    expect(report.summary.rowsToCreateWithSharedKey).toBe(1);
    expect(stockOf('96273708')).toMatchObject({ id, priceUzs: '155000' });
    expect(db.state.stocks).toHaveLength(2);
  });
});

describe('Driver’s Village — the dry run shows every key relation and writes nothing', () => {
  it('shared keys and possible renames are in the report', async () => {
    const { db, store, run, stockOf } = importHarness();
    await run([
      { code: '96273708' },
      { code: '96350526' },
      { code: '96350526-A' },
      { code: '00-00001431' },
    ]);
    const snapshot = JSON.stringify(db.state);
    const batches = store.applyBatchCalls;
    const calls = db.calls.length;

    const report = await run(
      [
        { code: '96273708 GMB', price: '165000' },
        { code: '96350526 OEM' },
        { code: 'БП-00001431' },
      ],
      { dryRun: true },
    );

    expect(report.meta.mode).toBe('dry-run');
    expect(report.summary).toMatchObject({
      rowsToUpdate: 0,
      rowsToCreate: 3,
      rowsToCreateWithSharedKey: 3,
      rowsWithPossibleRename: 2,
      written: null,
    });
    expect(
      report.keyShared.map((k) => [
        k.code1c,
        k.storedCodes,
        k.possibleRenameOf,
      ]),
    ).toEqual([
      ['96273708 GMB', ['96273708'], ['96273708']],
      ['96350526 OEM', ['96350526', '96350526-A'], ['96350526']],
      ['БП-00001431', ['00-00001431'], []],
    ]);
    expect(store.applyBatchCalls).toBe(batches);
    expect(db.calls).toHaveLength(calls);
    expect(JSON.stringify(db.state)).toBe(snapshot);
    expect(stockOf('96273708 GMB')).toBeUndefined();
  });
});
