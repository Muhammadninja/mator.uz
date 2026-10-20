// The home-grid bucket of a category-tree node (mainCategoryForCategory) — the
// one rule the projection and the backfill share. Pins every approved
// leaf → bucket decision, the precedence between a node and its ancestors, and
// that every seeded leaf has been decided one way or the other.

import { PartMainCategory as B } from '@prisma/client';
import { TAXONOMY } from '../../prisma/seed-data/subcategory-taxonomy.seed';
import {
  CATEGORIES_WITHOUT_MAIN_CATEGORY,
  CATEGORY_ID_TO_MAIN_CATEGORY,
  MAIN_CATEGORY_BY_SLUG,
  MainCategoryRules,
  categoryParentMap,
  mainCategoryForCategory,
} from './category-map';
import {
  LIVE_PARENTS,
  PRODUCTION_ONLY_NODES,
  SEEDED_LEAF_IDS,
  SEEDED_PARENTS,
  SEEDED_TREE,
} from './seeded-category-tree.test-util';

const bucketOf = (id: string, parents = SEEDED_PARENTS) =>
  mainCategoryForCategory(id, parents);

const subsOf = (rootId: string) =>
  TAXONOMY.filter((g) => g.parentId === rootId).flatMap((g) =>
    g.subs.map((s) => s.slug),
  );

describe('mainCategoryForCategory — roots mapped as a whole', () => {
  it('every brake node maps to BRAKES (root, bucket row and each sub)', () => {
    const nodes = ['brake-system', 'brakes', ...subsOf('brake-system')];
    expect(nodes).toEqual(
      expect.arrayContaining(['front-brake-pads', 'rear-brake-pads']),
    );
    for (const id of nodes) expect([id, bucketOf(id)]).toEqual([id, B.BRAKES]);
  });

  it('every suspension node maps to SUSPENSION (incl. steering racks)', () => {
    const nodes = [
      'suspension-and-steering',
      'suspension',
      ...subsOf('suspension-and-steering'),
    ];
    expect(nodes).toEqual(
      expect.arrayContaining(['shock-absorbers', 'steering-racks-tie-rods']),
    );
    for (const id of nodes) {
      expect([id, bucketOf(id)]).toEqual([id, B.SUSPENSION]);
    }
  });
});

describe('mainCategoryForCategory — each approved leaf', () => {
  const APPROVED: [string, B][] = [
    ['oil-filters', B.FILTERS],
    ['air-filters', B.FILTERS],
    ['cabin-filters', B.FILTERS],
    ['fuel-filters', B.FILTERS],
    ['synthetic-motor-oil', B.OIL_AND_FLUIDS],
    ['semi-synthetic-motor-oil', B.OIL_AND_FLUIDS],
    ['mineral-motor-oil', B.OIL_AND_FLUIDS],
    ['transmission-oil', B.OIL_AND_FLUIDS],
    ['antifreeze', B.OIL_AND_FLUIDS],
    ['technical-fluids', B.OIL_AND_FLUIDS],
    ['spark-plugs', B.IGNITION],
    ['ignition-coils-wires', B.IGNITION],
    ['alternators', B.ELECTRICAL_PARTS],
    ['starters', B.ELECTRICAL_PARTS],
    ['engine-sensors', B.ELECTRICAL_PARTS],
    ['tire-pressure-sensors', B.ELECTRICAL_PARTS],
    ['headlights-and-bulbs', B.LIGHTING],
    ['timing-belt-kits', B.BELTS_AND_HOSES],
    ['accessory-drive-belts', B.BELTS_AND_HOSES],
    ['gaskets-and-seals', B.ENGINE],
    ['piston-group', B.ENGINE],
    ['valves-and-cylinder-head', B.ENGINE],
    ['engine-mounts', B.ENGINE],
    ['wiper-blades', B.WIPERS],
    ['skid-plates', B.EXTERIOR],
    ['wind-deflectors-mudflaps', B.EXTERIOR],
  ];

  it.each(APPROVED)(
    '%s → %s, in the seeded and the live tree',
    (id, bucket) => {
      expect(bucketOf(id, SEEDED_PARENTS)).toBe(bucket);
      expect(bucketOf(id, LIVE_PARENTS)).toBe(bucket);
    },
  );

  it('wiper blades are matched by id, whichever root they hang under', () => {
    expect(SEEDED_PARENTS.get('wiper-blades')).toBe('cat_uncategorized');
    expect(LIVE_PARENTS.get('wiper-blades')).toBe('other');
    expect(bucketOf('wiper-blades', LIVE_PARENTS)).toBe(B.WIPERS);
  });

  it("a node's own rule applies even before the tree is loaded", () => {
    expect(mainCategoryForCategory('air-filters', new Map())).toBe(B.FILTERS);
  });

  it('a deeper node inherits its nearest decided ancestor', () => {
    const parents = categoryParentMap([
      ...SEEDED_TREE,
      { id: 'air-filters-sport', parentId: 'air-filters' },
    ]);
    expect(mainCategoryForCategory('air-filters-sport', parents)).toBe(
      B.FILTERS,
    );
  });
});

describe('mainCategoryForCategory — precedence', () => {
  // Synthetic rules: no real root fallback has a conflicting leaf beneath it,
  // so the rule itself is pinned here and the real tree below.
  const rules: MainCategoryRules = {
    byCategoryId: { sys: B.ENGINE, 'sys-belts': B.BELTS_AND_HOSES },
    withoutMainCategory: new Set(['sys-none']),
  };
  const parents = categoryParentMap([
    { id: 'sys', parentId: null },
    { id: 'sys-belts', parentId: 'sys' },
    { id: 'sys-belts-v', parentId: 'sys-belts' },
    { id: 'sys-plain', parentId: 'sys' },
    { id: 'sys-none', parentId: 'sys' },
    { id: 'belts-and-hoses', parentId: 'sys' },
  ]);
  const resolve = (id: string) => mainCategoryForCategory(id, parents, rules);

  it('a specific leaf mapping takes precedence over its parent fallback', () => {
    expect(resolve('sys-belts')).toBe(B.BELTS_AND_HOSES);
  });

  it('a node without a rule of its own takes the parent fallback', () => {
    expect(resolve('sys-plain')).toBe(B.ENGINE);
  });

  it('the NEAREST decided ancestor wins for a deeper node', () => {
    expect(resolve('sys-belts-v')).toBe(B.BELTS_AND_HOSES);
  });

  it('an explicit "no home bucket" also beats the parent fallback', () => {
    expect(resolve('sys-none')).toBeNull();
  });

  it('a bucket row is its own bucket, whatever its root falls back to', () => {
    expect(resolve('belts-and-hoses')).toBe(B.BELTS_AND_HOSES);
  });

  it('real tree: engine-system decides its belts before its internals', () => {
    expect(bucketOf('timing-belt-kits')).toBe(B.BELTS_AND_HOSES);
    expect(bucketOf('gaskets-and-seals')).toBe(B.ENGINE);
    expect(bucketOf('belts-and-hoses')).toBe(B.BELTS_AND_HOSES);
    expect(bucketOf('engine')).toBe(B.ENGINE);
  });
});

describe('mainCategoryForCategory — nodes left unbucketed', () => {
  it.each([
    'clutch-kits',
    'cv-joints-driveshafts',
    'flywheels',
    'cooling-radiators',
    'thermostats',
    'water-pumps',
    'coolant-hoses-tanks',
    'floor-mats',
    'seat-covers',
    'industrial-oil',
    'motorcycle-oil',
    'other-lubricants',
    'fasteners-and-clips',
    'cat_uncategorized',
    'transmission',
    'heating-and-cooling',
    'maintenance-and-fluids',
    'engine-system',
  ])('%s keeps main_category NULL', (id) => {
    expect(bucketOf(id, SEEDED_PARENTS)).toBeNull();
    expect(bucketOf(id, LIVE_PARENTS)).toBeNull();
  });

  it('production nodes nobody has reviewed do not inherit a guessed bucket', () => {
    const unreviewed = PRODUCTION_ONLY_NODES.map((n) => n.id).filter(
      (id) => id !== 'tire-pressure-sensors',
    );
    expect(unreviewed).toEqual(
      expect.arrayContaining(['fuel-and-oil-pumps', 'sealants', 'remote-keys']),
    );
    for (const id of unreviewed) {
      expect([id, bucketOf(id, LIVE_PARENTS)]).toEqual([id, null]);
    }
  });

  it('an unknown id, a prototype key or a cycle resolves to null', () => {
    expect(bucketOf('brand-new-node')).toBeNull();
    for (const id of [
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
    ]) {
      expect(bucketOf(id)).toBeNull();
    }
    const cycle = categoryParentMap([
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]);
    expect(mainCategoryForCategory('a', cycle)).toBeNull();
  });
});

describe('taxonomy coverage — every leaf is decided', () => {
  it('every seeded leaf is mapped or explicitly listed as having no home bucket', () => {
    expect(SEEDED_LEAF_IDS.length).toBeGreaterThan(60);
    const undecided = SEEDED_LEAF_IDS.filter(
      (id) =>
        bucketOf(id) === null && !CATEGORIES_WITHOUT_MAIN_CATEGORY.has(id),
    );
    expect(undecided).toEqual([]);
  });

  it('no seeded leaf is both mapped and listed as having no home bucket', () => {
    const contradictory = SEEDED_LEAF_IDS.filter(
      (id) => bucketOf(id) !== null && CATEGORIES_WITHOUT_MAIN_CATEGORY.has(id),
    );
    expect(contradictory).toEqual([]);
  });

  it('the mapping, the no-bucket list and the 12 bucket rows never overlap', () => {
    const mapped = Object.keys(CATEGORY_ID_TO_MAIN_CATEGORY);
    const listed = [...CATEGORIES_WITHOUT_MAIN_CATEGORY];
    expect(
      mapped.filter((id) => CATEGORIES_WITHOUT_MAIN_CATEGORY.has(id)),
    ).toEqual([]);
    expect(mapped.filter((id) => MAIN_CATEGORY_BY_SLUG.has(id))).toEqual([]);
    expect(listed.filter((id) => MAIN_CATEGORY_BY_SLUG.has(id))).toEqual([]);
  });

  it('every rule names a real node — seeded, or the one production-only node', () => {
    const seeded = new Set(SEEDED_TREE.map((r) => r.id));
    expect(
      Object.keys(CATEGORY_ID_TO_MAIN_CATEGORY).filter((id) => !seeded.has(id)),
    ).toEqual(['tire-pressure-sensors']);
    expect(
      [...CATEGORIES_WITHOUT_MAIN_CATEGORY].filter((id) => !seeded.has(id)),
    ).toEqual([]);
  });
});
