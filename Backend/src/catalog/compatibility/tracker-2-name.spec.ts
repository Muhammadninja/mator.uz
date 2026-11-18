// Chevrolet `tracker-2` is shown as "Tracker 2" (migration 20261201000000),
// while legacy fit rows file both Trackers under "Tracker". The app's garage
// screen sends the car as names (?make=Chevrolet&model=Tracker 2), so that path
// must still list the "Tracker" parts; a "Tracker 2" row stays Tracker 2's own.
//
// The listing's real where-clause is evaluated over in-memory parts (where-eval).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PartsService } from '../parts/parts.service';
import { ListPartsQueryDto } from '../parts/dto/list-parts.query.dto';
import { partCategoryFindMany } from '../categories/seeded-category-tree.test-util';
import { part } from './fitment-fixtures.test-util';
import { legacyFitModelNames } from './vehicle-fitment';
import { selectIds } from './where-eval.test-util';

const PARTS = [
  part({ id: 'tracker_row', fits: [['Chevrolet', 'Tracker']] }),
  part({ id: 'tracker_row_upper', fits: [['CHEVROLET', 'TRACKER']] }),
  part({ id: 'tracker2_row', fits: [['Chevrolet', 'Tracker 2']] }),
  part({ id: 'cobalt_row', fits: [['Chevrolet', 'Cobalt']] }),
  part({ id: 'kia_tracker_row', fits: [['Kia', 'Tracker']] }),
  part({ id: 'universal_oil', isUniversal: true }),
];

async function listed(query: Partial<ListPartsQueryDto>): Promise<string[]> {
  const calls: { where?: unknown } = {};
  const prisma = {
    partCategory: { findMany: jest.fn(partCategoryFindMany()) },
    catalogPart: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockImplementation((args: { where: unknown }) => {
        calls.where = args.where;
        return Promise.resolve([]);
      }),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _min: {}, _max: {} }),
      findFirst: jest.fn(),
    },
    partBrand: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const discounts = { loadActiveSales: jest.fn().mockResolvedValue([]) };
  await new PartsService(prisma as never, discounts as never).list(
    query,
    'ru',
    null,
  );
  return [...selectIds(PARTS, calls.where)].sort();
}

describe('legacyFitModelNames', () => {
  it('adds "Tracker" for Chevrolet "Tracker 2", whatever the case and spacing', () => {
    expect(legacyFitModelNames('Chevrolet', 'Tracker 2')).toEqual([
      'Tracker 2',
      'Tracker',
    ]);
    expect(legacyFitModelNames(' CHEVROLET ', 'tracker  2')).toEqual([
      'tracker  2',
      'Tracker',
    ]);
  });

  it('adds nothing for the first Tracker, another make, or no make', () => {
    expect(legacyFitModelNames('Chevrolet', 'Tracker')).toEqual(['Tracker']);
    expect(legacyFitModelNames('Kia', 'Tracker 2')).toEqual(['Tracker 2']);
    expect(legacyFitModelNames(null, 'Tracker 2')).toEqual(['Tracker 2']);
  });
});

describe('garage screen path for the two Trackers (?make=&model=)', () => {
  it('Chevrolet "Tracker 2" lists the "Tracker" rows and its own', async () => {
    expect(await listed({ make: 'Chevrolet', model: 'Tracker 2' })).toEqual(
      [
        'tracker2_row',
        'tracker_row',
        'tracker_row_upper',
        'universal_oil',
      ].sort(),
    );
  });

  it('Chevrolet "Tracker" does not list a "Tracker 2" row', async () => {
    expect(await listed({ make: 'Chevrolet', model: 'Tracker' })).toEqual(
      ['tracker_row', 'tracker_row_upper', 'universal_oil'].sort(),
    );
  });

  it('without a make, "Tracker 2" matches only rows naming it', async () => {
    expect(await listed({ model: 'Tracker 2' })).toEqual(
      ['tracker2_row', 'universal_oil'].sort(),
    );
  });
});

describe('migration 20261201000000 (Tracker 2 display name)', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../prisma/migrations/20261201000000_tracker_2_display_name/migration.sql',
    ),
    'utf8',
  )
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n');

  it('renames only the Chevrolet tracker-2 base row, and only from "Tracker"', () => {
    const updates = sql.match(/UPDATE "vehicle_models"/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(sql).toContain(`SET "name" = 'Tracker 2'`);
    expect(sql).toContain(`WHERE "id" = 'tracker-2'`);
    expect(sql).toContain(`AND "make_id" = 'chevrolet'`);
    expect(sql).toContain('AND "variant_of_model_id" IS NULL');
    expect(sql).toContain(`AND "name" = 'Tracker';`);
  });

  it('changes nothing but the name (and its timestamp)', () => {
    expect(sql).not.toMatch(/"year_from"|"year_to"|"id" =\s*'tracker'\s/);
    expect(sql).not.toMatch(/\b(DELETE|INSERT|ALTER|DROP)\b/);
  });
});
