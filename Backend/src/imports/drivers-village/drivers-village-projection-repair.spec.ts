// ING-001: a re-run of the same file repairs a catalog part that a failed or
// interrupted projection left behind. The real importer and real projection.
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import { importHarness } from '../../../test/utils/drivers-village-import-harness';

const CODE = 'DV-10001';
const row = { code: CODE, qty: '8', price: '150000' };

async function imported() {
  const h = importHarness();
  await h.run([row]);
  return { ...h, part: h.partOf(CODE)! };
}

/** The stock was written after its part: a projection that never happened. */
function markStale(h: ReturnType<typeof importHarness>) {
  (h.stockOf(CODE) as { updatedAt?: number }).updatedAt =
    Number.MAX_SAFE_INTEGER;
}

describe('Driver’s Village projection recovery (ING-001)', () => {
  it('a projection that fails after the stock committed is repaired by re-running the file', async () => {
    const h = await imported();
    const levels = jest
      .spyOn(CatalogProjectionService.prototype, 'projectStockLevels')
      .mockRejectedValueOnce(new Error('connection lost'));
    const failed = await h.run([{ ...row, price: '175000', qty: '3' }]);
    levels.mockRestore();
    expect(failed.summary.written?.projectionFailures).toBe(1);
    expect(Number(h.stockOf(CODE)!.priceUzs)).toBe(175000);
    expect(Number(h.partOf(CODE)!.priceUzs)).toBe(150000);

    const rerun = await h.run([{ ...row, price: '175000', qty: '3' }]);

    expect(rerun.summary.written?.projectionFailures).toBe(0);
    expect(rerun.summary.written?.skippedUnchanged).toBe(1);
    expect(rerun.summary.written?.projected).toBe(1);
    expect(Number(h.partOf(CODE)!.priceUzs)).toBe(175000);
    expect(h.partOf(CODE)!.stockQty).toBe(3);
  });

  it('repairs a price mismatch alone', async () => {
    const h = await imported();
    h.part.priceUzs = '1';
    markStale(h);
    await h.run([row]);
    expect(Number(h.partOf(CODE)!.priceUzs)).toBe(150000);
  });

  it('repairs a stock quantity mismatch', async () => {
    const h = await imported();
    h.part.stockQty = 99;
    markStale(h);
    await h.run([row]);
    expect(h.partOf(CODE)!.stockQty).toBe(8);
  });

  it('repairs an inStock mismatch, including a position zeroed in the file', async () => {
    const h = importHarness();
    await h.run([{ ...row, qty: '0' }]);
    h.partOf(CODE)!.inStock = true;
    markStale(h);
    await h.run([{ ...row, qty: '0' }]);
    expect(h.partOf(CODE)!.inStock).toBe(false);
  });

  it('leaves a manually chosen category alone while repairing', async () => {
    const h = await imported();
    h.part.categoryId = 'brake-system';
    h.part.priceUzs = '1';
    markStale(h);
    await h.run([row]);
    expect(h.partOf(CODE)!.categoryId).toBe('brake-system');
    expect(Number(h.partOf(CODE)!.priceUzs)).toBe(150000);
  });

  it('a row without a quantity does not touch availability', async () => {
    const h = await imported();
    h.part.stockQty = 99;
    markStale(h);
    await h.run([{ code: CODE, price: '150000', qty: '' }]);
    expect(h.partOf(CODE)!.stockQty).toBe(99);
  });

  it('never reverts a retail price and count an operator set after the projection', async () => {
    const h = await imported();
    h.part.priceUzs = '149000';
    h.part.stockQty = 2;
    await h.run([row]);
    expect(h.partOf(CODE)).toMatchObject({ priceUzs: '149000', stockQty: 2 });
  });

  it('changes nothing on a re-run of a fully successful import', async () => {
    const h = await imported();
    const before = h.position(CODE);
    const again = await h.run([row]);
    expect(again.summary.written?.projected).toBe(0);
    expect(again.summary.written?.created).toBe(0);
    expect(h.position(CODE)).toBe(before);
    expect(h.db.state.stocks).toHaveLength(1);
  });

  it('a dry run writes nothing, even with a stale part', async () => {
    const h = await imported();
    h.part.priceUzs = '1';
    markStale(h);
    await h.run([row], { dryRun: true });
    expect(h.partOf(CODE)!.priceUzs).toBe('1');
  });

  describe('a pending projection and manual changes (F1)', () => {
    /** A price or count written to Stock whose projection then failed. */
    async function failedProjection(
      file = { ...row, price: '175000', qty: '3' },
    ) {
      const h = await imported();
      const levels = jest
        .spyOn(CatalogProjectionService.prototype, 'projectStockLevels')
        .mockRejectedValueOnce(new Error('connection lost'));
      await h.run([file]);
      levels.mockRestore();
      return { ...h, file };
    }
    const marker = (h: { stockOf: (c: string) => unknown }) =>
      (h.stockOf(CODE) as { projectionPending?: unknown }).projectionPending;
    const conflicts = (report: { rows: { issues: { code: string }[] }[] }) =>
      report.rows.flatMap((r) =>
        r.issues.filter((i) => i.code === 'projection_conflict'),
      );

    it('records what the part held, in the same write as the stock', async () => {
      const h = await failedProjection();
      expect(marker(h)).toMatchObject({
        price: { base: expect.any(String) },
        quantity: { baseQty: 8, baseInStock: true },
      });
    });

    it('leaves no marker after a successful import', async () => {
      const h = await imported();
      await h.run([{ ...row, price: '175000' }]);
      expect(marker(h) ?? null).toBeNull();
    });

    it('repairs and clears the marker on a re-run', async () => {
      const h = await failedProjection();
      await h.run([h.file]);
      expect(Number(h.partOf(CODE)!.priceUzs)).toBe(175000);
      expect(h.partOf(CODE)!.stockQty).toBe(3);
      expect(marker(h) ?? null).toBeNull();
    });

    it('is not hidden by another write to the part (a category move)', async () => {
      const h = await failedProjection();
      Object.assign(h.partOf(CODE)!, {
        categoryId: 'brake-system',
        updatedAt: Number.MAX_SAFE_INTEGER,
      });
      await h.run([h.file]);
      expect(Number(h.partOf(CODE)!.priceUzs)).toBe(175000);
      expect(h.partOf(CODE)!.categoryId).toBe('brake-system');
    });

    it('keeps a price set by hand in the meantime and reports the conflict', async () => {
      const h = await failedProjection();
      h.partOf(CODE)!.priceUzs = '149000';
      const report = await h.run([h.file]);
      expect(h.partOf(CODE)!.priceUzs).toBe('149000');
      expect(conflicts(report)).toHaveLength(1);
      expect(report.summary.written?.projectionConflicts).toBe(1);
      expect(report.summary.written?.projectionFailures).toBe(0);
      expect(marker(h)).toHaveProperty('price');
    });

    it('still repairs the other column when only one was changed by hand', async () => {
      const h = await failedProjection();
      h.partOf(CODE)!.priceUzs = '149000';
      await h.run([h.file]);
      expect(h.partOf(CODE)!.stockQty).toBe(3);
      expect(marker(h)).not.toHaveProperty('quantity');
    });

    it('keeps a count set by hand in the meantime', async () => {
      const h = await failedProjection();
      h.partOf(CODE)!.stockQty = 50;
      const report = await h.run([h.file]);
      expect(h.partOf(CODE)!.stockQty).toBe(50);
      expect(conflicts(report)).toHaveLength(1);
    });

    it('stops reporting once the manual value agrees with the file', async () => {
      const h = await failedProjection();
      h.partOf(CODE)!.priceUzs = '175000';
      h.partOf(CODE)!.stockQty = 3;
      const report = await h.run([h.file]);
      expect(conflicts(report)).toHaveLength(0);
      expect(marker(h) ?? null).toBeNull();
    });

    it('a later change in the file decides the column, as any file change does', async () => {
      const h = await failedProjection();
      h.partOf(CODE)!.priceUzs = '149000';
      await h.run([{ ...h.file, price: '190000' }]);
      expect(Number(h.partOf(CODE)!.priceUzs)).toBe(190000);
      expect(marker(h) ?? null).toBeNull();
    });

    it('does not overwrite a manual change made while the run is in progress', async () => {
      const h = await failedProjection();
      const repair = jest
        .spyOn(CatalogProjectionService.prototype, 'repairStockLevels')
        .mockResolvedValueOnce(false);
      const report = await h.run([h.file]);
      repair.mockRestore();
      expect(report.summary.written?.projectionConflicts).toBe(1);
      expect(marker(h)).not.toBeNull();
    });

    it('settles on the next run if clearing the marker failed', async () => {
      const h = await failedProjection();
      await h.run([h.file]);
      (h.stockOf(CODE) as { projectionPending?: unknown }).projectionPending = {
        price: { base: '150000.00' },
      };
      await h.run([h.file]);
      expect(marker(h) ?? null).toBeNull();
    });

    it('a dry run reports a conflict and writes nothing', async () => {
      const h = await failedProjection();
      h.partOf(CODE)!.priceUzs = '149000';
      const before = marker(h);
      const report = await h.run([h.file], { dryRun: true });
      expect(conflicts(report)).toHaveLength(1);
      expect(marker(h)).toEqual(before);
    });
  });
});
