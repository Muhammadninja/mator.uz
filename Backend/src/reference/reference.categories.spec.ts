// The public category tree — GET /v1/reference/categories — end to end through
// the real controller, ReferenceService and PartCategoryService, over category
// rows shaped like the production `part_categories` table. Prisma is mocked
// (no DB) and the cache always misses, so every read runs the real query.
//
// Pins: the "Другое" root is served like any other root (its own id, slug and
// names, its children through ?parentId=), the internal `cat_uncategorized`
// node and the inactive `rul` are never served, and the seller bot's
// vehicle-category step still leaves "Другое" out.

import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';
import {
  PartCategoryService,
  type CategoryRow,
} from '../catalog/categories/part-category.service';
import { RedisKeys } from '../redis/redis.keys';

const row = (
  over: Partial<CategoryRow> & { id: string; parentId: string | null },
): CategoryRow => ({
  name: over.id,
  nameRu: over.id,
  nameUz: over.id,
  nameEn: over.id,
  slug: over.id,
  level: over.parentId === null ? 0 : 1,
  sortOrder: 0,
  isActive: true,
  mxik: null,
  packageCodeSingle: null,
  packageCodeSet: null,
  ...over,
});

const root = (
  id: string,
  sortOrder: number,
  [nameRu, nameUz, nameEn]: [string, string, string],
) =>
  row({ id, parentId: null, sortOrder, name: nameEn, nameRu, nameUz, nameEn });

/** The table's roots (names as stored), the parentless fallback node, and the
 *  subtrees these tests walk. */
const ROWS: CategoryRow[] = [
  root('brake-system', 0, [
    'Тормозная система',
    'Tormoz tizimi',
    'Brake System',
  ]),
  root('maintenance-and-fluids', 1, [
    'ТО и жидкости',
    'Texnik xizmat va suyuqliklar',
    'Maintenance & Fluids',
  ]),
  root('suspension-and-steering', 2, [
    'Подвеска и рулевое',
    'Osma va rul boshqaruvi',
    'Suspension & Steering',
  ]),
  root('electrical-and-lighting', 3, [
    'Электрика и освещение',
    'Elektr va yoritish',
    'Electrical & Lighting',
  ]),
  root('engine-system', 4, ['Двигатель', 'Dvigatel', 'Engine']),
  root('transmission', 5, ['Трансмиссия', 'Transmissiya', 'Transmission']),
  root('heating-and-cooling', 6, [
    'Отопление и охлаждение',
    'Isitish va sovutish',
    'Heating & Cooling',
  ]),
  root('tuning-and-accessories', 7, [
    'Тюнинг и аксессуары',
    'Tyuning va aksessuarlar',
    'Tuning & Accessories',
  ]),
  root('motor-oil', 8, ['Моторные масла', 'Motor moylari', 'Motor Oils']),
  { ...root('other', 99, ['Другое', 'Boshqa', 'Other']), name: 'Другое' },
  // Parentless but parked at level 1: the projection's fallback, not taxonomy.
  row({
    id: 'cat_uncategorized',
    parentId: null,
    level: 1,
    slug: 'uncategorized',
    nameRu: 'Другое',
    nameUz: 'Boshqa',
    nameEn: 'Uncategorized',
  }),

  row({ id: 'shock-absorbers', parentId: 'suspension-and-steering' }),
  row({
    id: 'rul',
    parentId: 'suspension-and-steering',
    isActive: false,
    nameRu: 'Руль',
  }),
  row({
    id: 'wheel-hubs-bearings',
    parentId: 'suspension-and-steering',
    sortOrder: 6,
  }),
  row({ id: 'suspension', parentId: 'suspension-and-steering', sortOrder: 10 }),
  row({ id: 'ball-bearings', parentId: 'wheel-hubs-bearings', level: 2 }),
  row({ id: 'roller-bearings', parentId: 'wheel-hubs-bearings', level: 2 }),

  row({ id: 'industrial-oil', parentId: 'other' }),
  row({ id: 'fasteners-and-clips', parentId: 'other' }),
  row({ id: 'motorcycle-oil', parentId: 'other', sortOrder: 1 }),
  row({ id: 'wiper-blades', parentId: 'other', sortOrder: 1 }),
  row({ id: 'agricultural-machinery', parentId: 'other', sortOrder: 2 }),
  row({ id: 'other-lubricants', parentId: 'other', sortOrder: 3 }),
];

/** Listed parts per category, as the root counts' GROUP BY returns them. */
const LISTED: Record<string, number> = {
  'brake-system': 2,
  'shock-absorbers': 3,
  'ball-bearings': 1,
  rul: 4,
  cat_uncategorized: 5,
  'motorcycle-oil': 2,
};

/** Prisma double for the partCategory reads the tree makes and the group-by
 *  the root counts make. */
function categoryDb() {
  return {
    partCategory: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(ROWS.find((r) => r.id === where.id) ?? null),
      ),
      findMany: jest.fn(({ where }: { where?: Partial<CategoryRow> }) => {
        // The root counts read the whole tree.
        if (!where) return Promise.resolve(ROWS);
        const out = ROWS.filter(
          (r) =>
            r.parentId === where.parentId &&
            (where.level === undefined || r.level === where.level) &&
            (where.isActive === undefined || r.isActive === where.isActive),
        );
        out.sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        );
        return Promise.resolve(out);
      }),
    },
    catalogPart: {
      groupBy: jest.fn(() =>
        Promise.resolve(
          Object.entries(LISTED).map(([categoryId, n]) => ({
            categoryId,
            _count: { _all: n },
          })),
        ),
      ),
    },
  };
}

function makeApi() {
  const cache = {
    remember: jest.fn(
      async (_k: string, _ttl: number, loader: () => Promise<unknown>) =>
        loader(),
    ),
    delete: jest.fn(),
  };
  const tree = new PartCategoryService(categoryDb() as never, cache as never);
  const reference = new ReferenceService({} as never, cache as never, tree);
  return { api: new ReferenceController(reference), tree, cache };
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('GET /v1/reference/categories — the public tree', () => {
  it('lists every root, "Другое" included, in the table order', async () => {
    const { items, total } = await makeApi().api.categories();
    expect(ids(items)).toEqual([
      'brake-system',
      'maintenance-and-fluids',
      'suspension-and-steering',
      'electrical-and-lighting',
      'engine-system',
      'transmission',
      'heating-and-cooling',
      'tuning-and-accessories',
      'motor-oil',
      'other',
    ]);
    expect(total).toBe(10);
  });

  it('serves "Другое" once, as a root with its own id, slug, names and count', async () => {
    const { items } = await makeApi().api.categories();
    expect(items.filter((i) => i.id === 'other')).toEqual([
      {
        id: 'other',
        name: 'Другое',
        nameRu: 'Другое',
        nameUz: 'Boshqa',
        nameEn: 'Other',
        slug: 'other',
        parentId: null,
        level: 0,
        sortOrder: 99,
        productsCount: 2,
      },
    ]);
  });

  it('serves the six children of "Другое" through ?parentId=other', async () => {
    const { items } = await makeApi().api.categories('other');
    expect(ids(items)).toEqual([
      'fasteners-and-clips',
      'industrial-oil',
      'motorcycle-oil',
      'wiper-blades',
      'agricultural-machinery',
      'other-lubricants',
    ]);
    expect(items.every((i) => i.parentId === 'other')).toBe(true);
  });

  it('never serves cat_uncategorized or the inactive rul', async () => {
    const { api } = makeApi();
    expect(ids((await api.categories()).items)).not.toContain(
      'cat_uncategorized',
    );
    const children = ids(
      (await api.categories('suspension-and-steering')).items,
    );
    expect(children).not.toContain('rul');
    expect(children).toEqual([
      'shock-absorbers',
      'wheel-hubs-bearings',
      'suspension',
    ]);
  });

  it('nests the bearings one level below wheel-hubs-bearings', async () => {
    const { items } = await makeApi().api.categoryChildren(
      'wheel-hubs-bearings',
    );
    expect(ids(items)).toEqual(['ball-bearings', 'roller-bearings']);
    expect(
      items.every((i) => i.parentId === 'wheel-hubs-bearings' && i.level === 2),
    ).toBe(true);
  });
});

describe('the seller bot keeps its own "Другое" button', () => {
  it('leaves "Другое" out of the vehicle-category step', async () => {
    const roots = await makeApi().tree.findRootCategories();
    expect(ids(roots)).not.toContain('other');
    expect(roots).toHaveLength(9);
  });

  it('reads the same cached roots the public tree does', async () => {
    const { api, tree, cache } = makeApi();
    await api.categories();
    await tree.findRootCategories();
    const keys = cache.remember.mock.calls.map(([key]) => key);
    // The counts ride beside the roots, under a key of their own.
    expect(keys).toEqual([
      RedisKeys.cacheReferenceCategories(),
      RedisKeys.cacheReferenceCategoryCounts(),
      RedisKeys.cacheReferenceCategories(),
    ]);
  });

  it('gets roots that carry no count', async () => {
    const roots = await makeApi().tree.findRootCategories();
    expect(roots.some((r) => 'productsCount' in r)).toBe(false);
  });
});

describe('productsCount on the roots', () => {
  const countsOf = async () =>
    Object.fromEntries(
      (await makeApi().api.categories()).items.map((i) => [
        i.id,
        'productsCount' in i ? i.productsCount : undefined,
      ]),
    );

  it('is served on every root, 0 where nothing is listed', async () => {
    expect(await countsOf()).toEqual({
      'brake-system': 2,
      'maintenance-and-fluids': 0,
      // shock absorbers + a ball bearing two levels down; rul's parts are out
      'suspension-and-steering': 4,
      'electrical-and-lighting': 0,
      'engine-system': 0,
      transmission: 0,
      'heating-and-cooling': 0,
      'tuning-and-accessories': 0,
      'motor-oil': 0,
      other: 2,
    });
  });

  it('is never served on a child', async () => {
    const { api } = makeApi();
    for (const parentId of ['suspension-and-steering', 'other']) {
      const { items } = await api.categories(parentId);
      expect(items.some((i) => 'productsCount' in i)).toBe(false);
    }
  });

  it('is left off, and the roots still served, when it cannot be counted', async () => {
    const { api, tree } = makeApi();
    jest
      .spyOn(tree, 'findCatalogRootProductCounts')
      .mockRejectedValue(new Error('statement timeout'));
    const { items, total } = await api.categories();
    expect(total).toBe(10);
    expect(items.some((i) => 'productsCount' in i)).toBe(false);
  });
});
