/**
 * Eight equal digits are no proof of one part. End to end (the real importer
 * and projection over the in-memory fakes, synthetic rows, no database): a
 * takeover only between the bare article and the article with a marker; a
 * changed marker or 1C series is a position of its own; a provable takeover
 * with rivals is a conflict. In no case is a stored position changed through
 * an unproven or ambiguous key.
 */
import { importHarness } from '../../../test/utils/drivers-village-import-harness';

describe('Driver’s Village — what the 8-digit key cannot prove', () => {
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
        rowsMatchedByKey: 0,
        keyConflicts: 0,
        rowsToCreateWithSharedKey: 1,
        positionsNotInFile: 1,
      });
      expect(report.keyShared).toEqual([
        {
          key,
          line: 2,
          code1c: newCode,
          fileCodes: [],
          storedCodes: [storedCode],
        },
      ]);
      expect(report.rows[0]).toMatchObject({
        outcome: 'create',
        written: 'created',
      });
      expect(
        report.rows[0].issues.find((i) => i.code === 'code_key_shared')!
          .message,
      ).toMatch(/cannot be proven/);
      expect(position(storedCode)).toBe(stored);
      expect(stockOf(newCode)).toMatchObject({
        priceUzs: '170000',
        quantity: 2,
      });
      expect(productOf(newCode)!.id).not.toBe(productOf(storedCode)!.id);
      expect(db.state.stocks).toHaveLength(2);
    },
  );

  it('several stored positions with the key and none provable: a position of its own, none of them changes', async () => {
    const { db, run, position } = importHarness();
    await run([{ code: '96273708 GMB' }, { code: '96273708-HN' }]);
    const before = [position('96273708 GMB'), position('96273708-HN')];

    const report = await run([{ code: '96273708 OEM' }]);

    expect(report.keyShared[0]).toMatchObject({
      code1c: '96273708 OEM',
      storedCodes: ['96273708 GMB', '96273708-HN'],
    });
    expect(report.summary).toMatchObject({
      rowsToCreateWithSharedKey: 1,
      keyConflicts: 0,
    });
    expect([position('96273708 GMB'), position('96273708-HN')]).toEqual(before);
    expect(db.state.stocks).toHaveLength(3);
  });
});

describe('Driver’s Village — an ambiguous 8-digit key is a conflict', () => {
  it('several stored positions with the key: nothing written for the row, none of them changes in any row', async () => {
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

    expect(report.rows[0].outcome).toBe('conflict');
    expect(report.rows[0].written).toBeUndefined();
    expect(
      report.rows[0].issues
        .filter((i) => i.severity === 'error')
        .map((i) => i.code),
    ).toEqual(['code_key_conflict']);
    expect(report.keyConflicts).toEqual([
      {
        key: '96273708',
        codes: ['96273708 OEM'],
        lines: [2],
        storedCodes: ['96273708', '96273708-HN'],
      },
    ]);
    expect(report.summary).toMatchObject({
      keyConflicts: 1,
      rowsInKeyConflict: 1,
      rowsMatchedByKey: 0,
      rowsToCreate: 1, // the unrelated row is imported as usual
    });
    // Stock, product, catalog part, fitment links and photos: untouched.
    expect([position('96273708'), position('96273708-HN')]).toEqual(before);
    expect(stockOf('96273708 OEM')).toBeUndefined();
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
    expect(report.summary).toMatchObject({ keyConflicts: 0 });
    expect(stockOf('96273708')!.priceUzs).toBe('155000');
    expect(position('96273708-HN')).toBe(other);
  });

  it('two codes of one file with the key of one stored position: neither is written, nothing is merged', async () => {
    const { db, run, position } = importHarness();
    await run([{ code: '96273708', qty: '8' }]);
    const before = position('96273708');

    const report = await run([
      { code: '96273708 GMB', price: '165000', qty: '5' },
      { code: '96273708 OEM', price: '190000', qty: '2' },
    ]);

    expect(report.rows.map((r) => r.outcome)).toEqual(['conflict', 'conflict']);
    expect(report.keyConflicts).toEqual([
      {
        key: '96273708',
        codes: ['96273708 GMB', '96273708 OEM'],
        lines: [2, 3],
        storedCodes: ['96273708'],
      },
    ]);
    expect(report.summary).toMatchObject({
      rowsInKeyConflict: 2,
      rowsToCreate: 0,
      rowsToUpdate: 0,
      written: { created: 0, updated: 0 },
    });
    expect(position('96273708')).toBe(before);
    expect(db.state.stocks).toHaveLength(1);
  });
});

describe('Driver’s Village — codes sharing a key with nothing to take over', () => {
  it('are separate positions: reported as code_key_shared, counted, never merged', async () => {
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
      rowsInKeyConflict: 0,
      rowsMatchedByKey: 0,
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

    // From now on each code updates its own position.
    const next = await run([
      { code: '96273708', price: '151000', qty: '8' },
      { code: '96273708 GMB', price: '166000', qty: '5' },
    ]);
    expect(next.summary).toMatchObject({
      rowsToUpdate: 2,
      rowsMatchedByKey: 0,
      rowsInKeyConflict: 0,
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

describe('Driver’s Village — the dry run shows every key decision and writes nothing', () => {
  it('matches, conflicts and shared keys are in the report', async () => {
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
        { code: '96273708 GMB', price: '165000' }, // takes over 96273708
        { code: '96350526 OEM' }, // two stored with the key: a conflict
        { code: 'БП-00001431' }, // another 1C series: its own position
      ],
      { dryRun: true },
    );

    expect(report.meta.mode).toBe('dry-run');
    expect(report.summary).toMatchObject({
      rowsToUpdate: 1,
      rowsToCreate: 1,
      rowsMatchedByKey: 1,
      keyConflicts: 1,
      rowsInKeyConflict: 1,
      rowsToCreateWithSharedKey: 1,
      written: null,
    });
    expect(report.keyMatches.map((m) => [m.code1c, m.storedCode])).toEqual([
      ['96273708 GMB', '96273708'],
    ]);
    expect(report.keyConflicts.map((c) => [c.codes, c.storedCodes])).toEqual([
      [['96350526 OEM'], ['96350526', '96350526-A']],
    ]);
    expect(report.keyShared.map((k) => [k.code1c, k.storedCodes])).toEqual([
      ['БП-00001431', ['00-00001431']],
    ]);
    expect(store.applyBatchCalls).toBe(batches);
    expect(db.calls).toHaveLength(calls);
    expect(JSON.stringify(db.state)).toBe(snapshot);
    expect(stockOf('96273708 GMB')).toBeUndefined();
  });
});
