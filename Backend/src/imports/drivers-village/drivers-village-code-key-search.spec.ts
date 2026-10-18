/**
 * The 8-digit key in the OEM index, and what the BUYER search finds with it:
 * the real importer and projection over the in-memory fakes, then the
 * catalog's own search predicate (PartsService, GET /v1/catalog/parts?q=…)
 * evaluated over the projected catalog_parts rows. Synthetic rows, no
 * database.
 */
import { selectIds } from '../../catalog/compatibility/where-eval.test-util';
import { PartsService } from '../../catalog/parts/parts.service';
import { importHarness } from '../../../test/utils/drivers-village-import-harness';

/** The catalog part ids the buyer search returns for `q`, over these rows. */
async function search(
  parts: Record<string, unknown>[],
  q: string,
): Promise<string[]> {
  let where: unknown;
  const prisma = {
    catalogPart: {
      count: () => Promise.resolve(0),
      findMany: (args: { where: unknown }) => {
        where = args.where;
        return Promise.resolve([]);
      },
      groupBy: () => Promise.resolve([]),
      aggregate: () => Promise.resolve({ _min: {}, _max: {} }),
    },
    partBrand: { findMany: () => Promise.resolve([]) },
    vehicle: { findFirst: () => Promise.resolve(null) },
  };
  const discounts = {
    loadActiveSales: () => Promise.resolve([]),
    calculateDiscount: (price: number) => ({
      originalPrice: price,
      finalPrice: price,
      discountAmount: 0,
      discountPercent: 0,
      appliedSale: null,
    }),
  };
  await new PartsService(prisma as never, discounts as never).list({ q });
  // The dealer is not suspended (the buyer-visibility rule of every listing).
  return selectIds(
    parts.map((p) => ({ ...p, seller: { status: 'ACTIVE' } })),
    where,
  );
}

/**
 * OEM values that more than one of the seller's positions carry. The index
 * also binds 1C stock uploads to catalog parts (sync-inventory, first part
 * with the article wins), so the key must never create one.
 */
function sharedValues(rows: Record<string, unknown>[]): string[] {
  const seen = new Map<string, number>();
  for (const r of rows)
    for (const v of new Set(r.oemNumbers as string[]))
      seen.set(v, (seen.get(v) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([v]) => v);
}

describe('Driver’s Village — the 8-digit key in the OEM search index', () => {
  it('after `96273708` became `96273708 GMB`, the part is found by 96273708 and by its full code', async () => {
    const { db, run, partOf } = importHarness();
    await run([{ code: '96273708' }]);
    const parts = db.state.catalogParts;
    expect(await search(parts, '96273708')).toEqual([partOf('96273708')!.id]);

    await run([{ code: '96273708 GMB', price: '165000' }]);

    const id = partOf('96273708 GMB')!.id;
    for (const q of ['96273708', '96273708 GMB', '96273708-gmb'])
      expect(await search(parts, q)).toEqual([id]);
    expect(await search(parts, '96273709')).toEqual([]);
  });

  it.each([
    ['96273708 GMB', ['96273708GMB', '96273708']],
    ['GMB 96273708', ['GMB96273708', '96273708']],
    ['96273708-OEM', ['96273708OEM', '96273708']],
  ])(
    'a new %s: indexed by its own code and by its key',
    async (code, index) => {
      const { db, run, productOf, partOf } = importHarness();
      await run([{ code }]);
      expect(productOf(code)!.oemNumbers).toEqual(index);
      expect(partOf(code)!.oemNumbers).toEqual(index);
      for (const q of ['96273708', code])
        expect(await search(db.state.catalogParts, q)).toEqual([
          partOf(code)!.id,
        ]);
    },
  );

  it('a re-import never repeats a value in the index, and writes nothing', async () => {
    const { db, store, run, productOf, partOf } = importHarness();
    await run([{ code: '96273708' }]);
    await run([{ code: '96273708 GMB' }]);
    const snapshot = JSON.stringify(db.state);
    const batches = store.applyBatchCalls;

    for (let i = 0; i < 2; i += 1) {
      const again = await run([{ code: '96273708 GMB' }]);
      expect(again.summary).toMatchObject({ rowsUnchanged: 1 });
    }

    expect(productOf('96273708 GMB')!.oemNumbers).toEqual([
      '96273708GMB',
      '96273708',
    ]);
    expect(partOf('96273708 GMB')!.oemNumbers).toEqual([
      '96273708GMB',
      '96273708',
    ]);
    expect(store.applyBatchCalls).toBe(batches);
    expect(JSON.stringify(db.state)).toBe(snapshot);
  });

  it('a key two positions share is indexed on neither key-only: the bare article finds the bare part, the full code the other', async () => {
    const { db, run, productOf, partOf } = importHarness();
    await run([{ code: '96273708' }, { code: '96273708 GMB' }]);

    expect(productOf('96273708')!.oemNumbers).toEqual(['96273708']);
    expect(productOf('96273708 GMB')!.oemNumbers).toEqual(['96273708GMB']);
    expect(sharedValues(db.state.products)).toEqual([]);
    expect(sharedValues(db.state.catalogParts)).toEqual([]);
    const parts = db.state.catalogParts;
    expect(await search(parts, '96273708')).toEqual([partOf('96273708')!.id]);
    expect(await search(parts, '96273708 GMB')).toEqual([
      partOf('96273708 GMB')!.id,
    ]);
  });

  it('a key that becomes shared leaves the index of the position that had it alone', async () => {
    const { db, run, productOf } = importHarness();
    await run([{ code: '96273708 GMB' }]);
    expect(productOf('96273708 GMB')!.oemNumbers).toContain('96273708');

    const report = await run([{ code: '96273708 GMB' }, { code: '96273708' }]);

    expect(report.rows[0]).toMatchObject({
      outcome: 'update',
      changes: ['oem_numbers'],
    });
    expect(productOf('96273708 GMB')!.oemNumbers).toEqual(['96273708GMB']);
    expect(productOf('96273708')!.oemNumbers).toEqual(['96273708']);
    expect(sharedValues(db.state.products)).toEqual([]);
  });

  it('an unproven change (GMB → OEM) indexes the new position by its own code only; the stored one keeps its index', async () => {
    const { db, run, productOf, partOf, position } = importHarness();
    await run([{ code: '96273708 GMB' }]);
    const stored = position('96273708 GMB');

    await run([{ code: '96273708 OEM' }]);

    expect(position('96273708 GMB')).toBe(stored);
    expect(productOf('96273708 OEM')!.oemNumbers).toEqual(['96273708OEM']);
    expect(sharedValues(db.state.products)).toEqual([]);
    const parts = db.state.catalogParts;
    expect(await search(parts, '96273708')).toEqual([
      partOf('96273708 GMB')!.id,
    ]);
    expect(await search(parts, '96273708 OEM')).toEqual([
      partOf('96273708 OEM')!.id,
    ]);
  });
});
