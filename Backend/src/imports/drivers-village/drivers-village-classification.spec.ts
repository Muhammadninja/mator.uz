/**
 * The classification import end to end: the real classification service and
 * the REAL Stock → CatalogPart projection over the in-memory fakes, applied
 * to positions the price/stock sync created. Synthetic rows in the layout of
 * the prepared file final_1c.txt (tab, CRLF, blank rows after the header);
 * no database.
 */
import {
  classificationFile,
  importHarness,
  type Cells,
} from '../../../test/utils/drivers-village-import-harness';
import { FakeClassificationStore } from '../../../test/utils/drivers-village-fake-db';
import { DriversVillageClassificationService } from './drivers-village-classification.service';

/** The live category tree the file is checked against. */
const TREE = [
  { id: 'cat_uncategorized', parentId: null, isActive: true },
  { id: 'suspension-and-steering', parentId: null, isActive: true },
  {
    id: 'shock-absorbers',
    parentId: 'suspension-and-steering',
    isActive: true,
  },
  {
    id: 'control-arms-bushings',
    parentId: 'suspension-and-steering',
    isActive: true,
  },
  { id: 'engine-system', parentId: null, isActive: true },
  { id: 'gaskets-and-seals', parentId: 'engine-system', isActive: true },
  { id: 'brake-system', parentId: null, isActive: true },
  { id: 'brake-discs', parentId: 'brake-system', isActive: true },
  { id: 'old-brakes', parentId: 'brake-system', isActive: false },
];

const HEADER = [
  'name',
  'manufacturer_part_number',
  'unit',
  'price',
  'vehicle_make',
  'vehicle_model',
  'category_id',
  'subcategory_id',
  'code_1c',
];

interface Row {
  code: string;
  cat?: string;
  sub?: string;
  make?: string;
  model?: string;
}

/** A prepared file: price, unit and name cells are there but never read. */
const file = (...rows: Row[]) =>
  classificationFile(HEADER, [
    Array<string>(HEADER.length).fill(''), // the blank rows final_1c.txt has
    ...rows.map((r) => [
      'Амортизаторы передней подвески',
      r.code,
      'шт.',
      '1,00', // a price the classification never reads
      r.make ?? 'CHEVROLET',
      r.model ?? 'DAMAS-2, LABO',
      r.cat ?? 'suspension-and-steering',
      r.sub ?? 'shock-absorbers',
      r.code,
    ]),
  ]);

async function stored(...positions: Cells[]) {
  const h = importHarness({}, { partCategories: TREE });
  await h.run(positions.length ? positions : [{ code: '42792442' }]);
  return h;
}

describe('Driver’s Village classification — categories', () => {
  it('a position in the fallback bucket gets the prepared category through the projection; price, stock, photos and catalog settings stay', async () => {
    const h = await stored({
      code: '42792442',
      model: '',
      make: '',
      price: '490000',
      qty: '7',
    });
    const productId = h.productOf('42792442')!.id;
    h.db.state.productImages.push({ productId, url: 'https://img/1.jpg' });
    const settings = {
      images: ['https://img/1.jpg'],
      purchasePriceUzs: '400000',
      cashbackPct: '3',
      priceUzs: '495000', // an operator's retail price
      stockQty: 4,
    };
    Object.assign(h.partOf('42792442')!, settings);
    const stock = JSON.stringify(h.stockOf('42792442'));

    const report = await h.classify(file({ code: '42792442' }));

    expect(report.positions).toEqual([
      expect.objectContaining({
        code1c: '42792442',
        lines: [3],
        outcome: 'apply',
        category: {
          action: 'assign',
          existing: null,
          file: {
            categoryId: 'suspension-and-steering',
            subcategoryId: 'shock-absorbers',
          },
          planned: 'shock-absorbers',
        },
        written: 'applied',
        categoryWritten: true,
        projected: true,
      }),
    ]);
    expect(h.productOf('42792442')).toMatchObject({
      categoryId: 'shock-absorbers',
      vehicleCategoryId: 'suspension-and-steering',
      vehicleCategory: 'SUSPENSION_AND_STEERING',
      mainCategory: null,
    });
    expect(h.partOf('42792442')).toMatchObject({
      categoryId: 'shock-absorbers',
      vehicleCategory: 'SUSPENSION_AND_STEERING',
      ...settings,
    });
    expect(JSON.stringify(h.stockOf('42792442'))).toBe(stock);
    expect(h.modelsOf('42792442')).toEqual([
      'Chevrolet|Damas',
      'Chevrolet|Labo',
    ]);
    expect(h.fitsOf('42792442')).toEqual([
      'model_chevrolet_damas',
      'model_chevrolet_labo',
    ]);
    expect(report.summary).toMatchObject({
      positionsFound: 1,
      category: { assign: 1 },
      modelLinksAdded: 2,
      written: { positions: 1, categoriesWritten: 1, projected: 1 },
    });
  });

  it('a category set in Mator is never replaced, even when the file conflicts: manual_category_preserved names the ignored value', async () => {
    const h = await stored();
    h.partOf('42792442')!.categoryId = 'brake-discs'; // admin bulk-move

    for (let run = 0; run < 2; run += 1) {
      const report = await h.classify(file({ code: '42792442' }));
      const p = report.positions[0];
      expect(p.category).toMatchObject({
        action: 'preserved',
        existing: 'brake-discs',
        file: { subcategoryId: 'shock-absorbers' },
        planned: null,
      });
      expect(
        p.issues.find((i) => i.code === 'manual_category_preserved')!.message,
      ).toMatch(/"brake-discs", is kept.*"shock-absorbers".*ignored/);
      expect(h.partOf('42792442')!.categoryId).toBe('brake-discs');
      expect(h.productOf('42792442')!.categoryId).toBeNull();
    }
  });

  it('a subcategory set in Mator is kept against another or a less precise category', async () => {
    const h = await stored({ code: 'S-1' }, { code: 'S-2' });
    h.partOf('S-1')!.categoryId = 'shock-absorbers';
    h.partOf('S-2')!.categoryId = 'shock-absorbers';

    const report = await h.classify(
      file(
        { code: 'S-1', sub: 'control-arms-bushings' },
        { code: 'S-2', sub: '' }, // the category level alone
      ),
    );

    expect(report.positions.map((p) => p.category.action)).toEqual([
      'preserved',
      'preserved',
    ]);
    expect(h.partOf('S-1')!.categoryId).toBe('shock-absorbers');
    expect(h.partOf('S-2')!.categoryId).toBe('shock-absorbers');
  });

  it('a category set at one level is kept; the subcategory below it is filled in from the file', async () => {
    const h = await stored();
    h.partOf('42792442')!.categoryId = 'suspension-and-steering';

    const report = await h.classify(file({ code: '42792442' }));

    expect(report.positions[0].category).toMatchObject({
      action: 'refine',
      existing: 'suspension-and-steering',
      planned: 'shock-absorbers',
    });
    expect(report.positions[0].issues.map((i) => i.code)).toContain(
      'category_refined',
    );
    expect(h.partOf('42792442')).toMatchObject({
      categoryId: 'shock-absorbers',
      vehicleCategory: 'SUSPENSION_AND_STEERING',
    });
    expect(h.productOf('42792442')!.vehicleCategoryId).toBe(
      'suspension-and-steering',
    );
  });

  it('an unknown, inactive or contradictory category changes nothing and says why; categories are never created', async () => {
    const h = await stored(
      { code: 'U-1' },
      { code: 'U-2' },
      { code: 'U-3' },
      { code: 'U-4' },
    );
    const report = await h.classify(
      file(
        { code: 'U-1', cat: 'engine', sub: 'gaskets-and-seals' }, // engine-system's
        { code: 'U-2', sub: 'no-such-category' },
        { code: 'U-3', cat: 'brake-system', sub: 'old-brakes' },
        { code: 'U-4', cat: 'cat_uncategorized', sub: '' },
      ),
    );

    expect(
      report.positions.map((p) => [
        p.category.action,
        p.issues.find((i) => i.field === 'category')?.code,
      ]),
    ).toEqual([
      ['invalid', 'category_mismatch'],
      ['invalid', 'category_unknown'],
      ['invalid', 'category_inactive'],
      ['invalid', 'category_fallback'],
    ]);
    expect(report.categoryProblems[0].message).toMatch(
      /"gaskets-and-seals" belongs to "engine-system" in Mator, not to "engine"/,
    );
    for (const code of ['U-1', 'U-2', 'U-3', 'U-4']) {
      expect(h.partOf(code)!.categoryId).toBe('cat_uncategorized');
      expect(h.productOf(code)!.categoryId).toBeNull();
    }
    expect(h.db.state.partCategories).toEqual(TREE);
  });

  it('rows of one code that disagree on the category change nothing; their vehicles are merged', async () => {
    const h = await stored({ code: 'K-1', model: '', make: '' });

    const report = await h.classify(
      file(
        { code: 'K-1', model: 'DAMAS-2' },
        { code: 'K-1', cat: 'brake-system', sub: 'brake-discs', model: 'LABO' },
      ),
    );

    expect(report.positions[0]).toMatchObject({
      lines: [3, 4],
      category: { action: 'conflict' },
    });
    expect(h.partOf('K-1')!.categoryId).toBe('cat_uncategorized');
    expect(h.modelsOf('K-1')).toEqual(['Chevrolet|Damas', 'Chevrolet|Labo']);
  });

  it('empty cells never clear a category or fitment', async () => {
    const h = await stored({ code: 'Z-1', model: 'COBALT' });
    h.partOf('Z-1')!.categoryId = 'shock-absorbers';
    const before = h.position('Z-1');
    const fits = h.fitsOf('Z-1');

    const report = await h.classify(
      file({ code: 'Z-1', cat: '', sub: '', make: '', model: '' }),
    );

    expect(report.positions[0]).toMatchObject({
      outcome: 'unchanged',
      category: { action: 'none' },
    });
    expect(h.classificationStore.applyCalls).toBe(0);
    expect(h.position('Z-1')).toBe(before);
    expect(h.fitsOf('Z-1')).toEqual(fits);
  });
});

describe('Driver’s Village classification — vehicles', () => {
  it('adds the file’s vehicles to the stored ones and removes none; Fitment Studio bindings stay', async () => {
    const h = await stored({ code: 'V-1', model: 'COBALT' });
    const binding = {
      partId: h.partOf('V-1')!.id,
      vehicleModelId: 'cobalt',
      nodeId: 'node-1',
    };
    h.db.state.fitmentBindings.push({ ...binding });
    h.catalog.calls.length = 0;

    const report = await h.classify(file({ code: 'V-1' }));

    expect(h.modelsOf('V-1')).toEqual([
      'Chevrolet|Cobalt',
      'Chevrolet|Damas',
      'Chevrolet|Labo',
    ]);
    expect(h.fitsOf('V-1')).toEqual([
      'model_chevrolet_cobalt',
      'model_chevrolet_damas',
      'model_chevrolet_labo',
    ]);
    expect(h.catalog.calls).toEqual([]); // no fit deleted
    expect(h.db.state.fitmentBindings).toEqual([binding]);
    expect(report.positions[0].issues.map((i) => i.code)).toContain(
      'curated_fitment_present',
    );
  });

  it('a part the 1C import marked universal (from empty cells) becomes specific when the file names its vehicles', async () => {
    const h = await stored({ code: 'W-1', model: '', make: '' });
    h.productOf('W-1')!.isUniversal = true; // as the old import left it
    h.partOf('W-1')!.isUniversal = true;

    const report = await h.classify(file({ code: 'W-1' }));

    expect(report.positions[0].vehicles.clearUniversal).toBe(true);
    expect(report.positions[0].issues.map((i) => i.code)).toContain(
      'universal_cleared',
    );
    expect(h.productOf('W-1')!.isUniversal).toBe(false);
    expect(h.partOf('W-1')!.isUniversal).toBe(false);
    expect(h.modelsOf('W-1')).toEqual(['Chevrolet|Damas', 'Chevrolet|Labo']);
  });

  it('a universal part stays universal when the file names no vehicle', async () => {
    const h = await stored({ code: 'W-2', model: '', make: '' });
    h.productOf('W-2')!.isUniversal = true;

    await h.classify(file({ code: 'W-2', make: '', model: '' }));

    expect(h.productOf('W-2')!.isUniversal).toBe(true);
  });
});

describe('Driver’s Village classification — safety', () => {
  it('applying the same file again creates nothing and changes nothing', async () => {
    const h = await stored({ code: 'I-1' }, { code: 'I-2', model: '' });
    const prepared = file({ code: 'I-1' }, { code: 'I-2' });
    await h.classify(prepared);
    const snapshot = JSON.stringify([h.db.state, h.catalog.fits]);
    const calls = h.classificationStore.applyCalls;

    const again = await h.classify(prepared);

    expect(again.positions.map((p) => p.outcome)).toEqual([
      'unchanged',
      'unchanged',
    ]);
    expect(again.summary.positionsToApply).toBe(0);
    expect(h.classificationStore.applyCalls).toBe(calls);
    expect(JSON.stringify([h.db.state, h.catalog.fits])).toBe(snapshot);
    expect(h.db.state.stocks).toHaveLength(2);
    expect(h.db.state.products).toHaveLength(2);
  });

  it('a dry run plans everything and writes nothing', async () => {
    const h = await stored();
    const snapshot = JSON.stringify(h.db.state);

    const report = await h.classify(file({ code: '42792442' }), {
      dryRun: true,
    });

    expect(report.meta.mode).toBe('dry-run');
    expect(report.positions[0]).toMatchObject({
      outcome: 'apply',
      category: { action: 'assign', planned: 'shock-absorbers' },
    });
    expect(report.summary.written).toBeNull();
    expect(h.classificationStore.applyCalls).toBe(0);
    expect(JSON.stringify(h.db.state)).toBe(snapshot);
  });

  it('a category an operator sets while the file is applied wins (compare-and-set)', async () => {
    const h = await stored();
    class Racing extends FakeClassificationStore {
      async applyClassificationBatch(
        ...args: Parameters<FakeClassificationStore['applyClassificationBatch']>
      ) {
        h.partOf('42792442')!.categoryId = 'brake-discs'; // admin, meanwhile
        return super.applyClassificationBatch(...args);
      }
    }
    const service = new DriversVillageClassificationService(
      new Racing(h.db),
      h.projection,
    );

    const report = await service.run(
      file({ code: '42792442' }),
      'final_1c.txt',
      { dryRun: false },
    );

    expect(report.positions[0]).toMatchObject({
      written: 'applied',
      categoryWritten: false,
    });
    expect(report.summary.written).toMatchObject({
      categoriesWritten: 0,
      categoriesKeptChanged: 1,
    });
    expect(report.positions[0].issues.map((i) => i.code)).toContain(
      'category_changed_meanwhile',
    );
    expect(h.partOf('42792442')!.categoryId).toBe('brake-discs');
    expect(h.productOf('42792442')!.categoryId).toBeNull();
  });

  it('a code without a position is reported and never created; unusable rows are listed', async () => {
    const h = await stored();
    const report = await h.classify(
      file({ code: 'NO-SUCH-1' }, { code: '3333' }, { code: '' }),
    );

    expect(report.positions).toEqual([
      expect.objectContaining({ code1c: 'NO-SUCH-1', outcome: 'not_found' }),
    ]);
    expect(report.rejected.map((r) => r.issues[0].code)).toEqual([
      'placeholder_code_1c',
      'empty_code_1c',
    ]);
    expect(report.summary).toMatchObject({
      positionsNotFound: 1,
      rejectedRows: 2,
    });
    expect(h.db.state.stocks).toHaveLength(1);
  });

  it('reads only its columns: a file without classification columns is refused before anything is read', async () => {
    const h = await stored();
    const report = await h.classify(
      classificationFile(
        ['code_1c', 'name', 'price'],
        [['42792442', 'x', '1']],
      ),
    );
    expect(report.meta.aborted).toBe(true);
    expect(report.meta.abortReason).toMatch(/No classification column/);
    expect(h.classificationStore.applyCalls).toBe(0);
  });
});
