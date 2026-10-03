// The buyer's garage filter, as the app actually calls it.
//
// The garage screen's "Shop parts that fit" sends the active car as NAMES —
// GET /v1/catalog/parts?make=Chevrolet&model=Cobalt — not as a vehicle id, so
// that path must give the same answers as the vehicle_id path: exact model,
// admin curation over seller data, Nexia 2 ≠ Nexia 3, and make and model
// matched on the SAME row. A `vehicle_id`, where one is sent, resolves only in
// the caller's own garage.
//
// The listing's real where-clause is evaluated over the shared in-memory
// fixtures (where-eval): logic-level, no PostgreSQL.

import { PartsService } from './parts.service';
import { ListPartsQueryDto } from './dto/list-parts.query.dto';
import { selectIds } from '../compatibility/where-eval.test-util';
import * as fx from '../compatibility/fitment-fixtures.test-util';

const OWNER = 'usr_owner';

/** Prisma double: records the listing predicate; garage rows owner-scoped. */
function makePrisma(garage: fx.VehicleKey = 'cobalt') {
  const calls: { where?: unknown } = {};
  return {
    calls,
    catalogPart: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockImplementation((args: { where: unknown }) => {
        calls.where = args.where;
        return Promise.resolve([]);
      }),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _min: {}, _max: {} }),
      findUnique: jest.fn(),
    },
    partBrand: { findMany: jest.fn().mockResolvedValue([]) },
    // Like the database: the garage row comes back only for a lookup scoped
    // to its live (not soft-deleted) owner.
    vehicle: {
      findFirst: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { userId?: string; deletedAt?: null } }) =>
            Promise.resolve(
              where.userId === OWNER && where.deletedAt === null
                ? fx.vehicleRow(fx.VEHICLES[garage])
                : null,
            ),
        ),
    },
  };
}

const noDiscounts = { loadActiveSales: jest.fn().mockResolvedValue([]) };

async function listed(
  query: Partial<ListPartsQueryDto>,
  userId: string | null = null,
  garage?: fx.VehicleKey,
) {
  const prisma = makePrisma(garage);
  const svc = new PartsService(prisma as never, noDiscounts as never);
  await svc.list(query, 'ru', userId);
  return { ids: selectIds(fx.PARTS, prisma.calls.where), prisma };
}

describe('garage screen path: ?make=<name>&model=<name> (what the app sends)', () => {
  it('Chevrolet Cobalt sees exactly the parts that fit a Cobalt', async () => {
    const { ids } = await listed({ make: 'Chevrolet', model: 'Cobalt' });
    expect([...ids].sort()).toEqual(
      [
        'curated_cobalt',
        'curated_multi', // Cobalt + Gentra + Nexia 3
        'legacy_cobalt', // seller row "Chevrolet Cobalt", no curation
        'makewide_chevrolet', // seller "every Chevrolet", no curation
        'universal_oil',
      ].sort(),
    );
  });

  it('Part → Spark: a Cobalt does not see it, a Spark does', async () => {
    const cobalt = await listed({ make: 'Chevrolet', model: 'Cobalt' });
    const spark = await listed({ make: 'Chevrolet', model: 'Spark' });
    expect(cobalt.ids).not.toContain('curated_spark');
    expect(cobalt.ids).not.toContain('legacy_spark');
    expect(spark.ids).toContain('curated_spark');
  });

  it('Part → Cobalt + Gentra (+ Nexia 3): each of them sees it', async () => {
    for (const model of ['Cobalt', 'Gentra', 'Nexia 3']) {
      const { ids } = await listed({ make: 'Chevrolet', model });
      expect(ids).toContain('curated_multi');
    }
    const { ids } = await listed({ make: 'Chevrolet', model: 'Spark' });
    expect(ids).not.toContain('curated_multi');
  });

  it('Nexia 2 ≠ Nexia 3: a binding to one never reaches the other', async () => {
    const n2 = await listed({ make: 'Chevrolet', model: 'Nexia 2' });
    const n3 = await listed({ make: 'Chevrolet', model: 'Nexia 3' });
    expect(n2.ids).toContain('curated_nexia2');
    expect(n2.ids).not.toContain('curated_nexia3');
    expect(n2.ids).not.toContain('legacy_nexia3');
    expect(n3.ids).toContain('curated_nexia3');
    expect(n3.ids).not.toContain('curated_nexia2');
  });

  it('admin curation beats seller data: a seller make-wide "Chevrolet" row cannot widen a part curated to Gentra', async () => {
    // curated_overrides_makewide: imported as every-Chevrolet, curated to Gentra.
    const spark = await listed({ make: 'Chevrolet', model: 'Spark' });
    const gentra = await listed({ make: 'Chevrolet', model: 'Gentra' });
    expect(spark.ids).not.toContain('curated_overrides_makewide');
    expect(gentra.ids).toContain('curated_overrides_makewide');
  });

  it('admin curation beats seller data: a seller "Cobalt" row on a part curated to Spark', async () => {
    const cobalt = await listed({ make: 'Chevrolet', model: 'Cobalt' });
    expect(cobalt.ids).not.toContain('curated_overrides_legacy');
  });

  it('make and model must match on the SAME row — no cross-row "model OR make" leak', async () => {
    const parts = [
      // Seller rows "Chevrolet Spark" + "Ravon Cobalt": neither is a Chevrolet Cobalt.
      fx.part({
        id: 'legacy_cross',
        fits: [
          ['Chevrolet', 'Spark'],
          ['Ravon', 'Cobalt'],
        ],
      }),
      // Curated to Kia Rio + Chevrolet Spark: not a "Kia Spark".
      fx.part({ id: 'curated_cross', curated: ['kia-rio', 'spark'] }),
    ];
    const where = async (query: Partial<ListPartsQueryDto>) => {
      const prisma = makePrisma();
      await new PartsService(prisma as never, noDiscounts as never).list(query);
      return selectIds(parts, prisma.calls.where);
    };
    expect(await where({ make: 'Chevrolet', model: 'Cobalt' })).toEqual([]);
    expect(await where({ make: 'Kia', model: 'Spark' })).toEqual([]);
    // Each real pair still matches its own row.
    expect(await where({ make: 'Ravon', model: 'Cobalt' })).toEqual([
      'legacy_cross',
    ]);
    expect(await where({ make: 'Chevrolet', model: 'Spark' })).toEqual([
      'legacy_cross',
      'curated_cross',
    ]);
  });

  it('a model name alone still matches across makes (no make given, nothing to pair)', async () => {
    const { ids } = await listed({ model: 'Cobalt' });
    expect(ids).toEqual(
      expect.arrayContaining(['curated_cobalt', 'legacy_cobalt']),
    );
  });
});

describe('vehicle_id path: resolved only in the caller garage', () => {
  it('the owner gets the Cobalt-filtered listing', async () => {
    const { ids } = await listed({ vehicle_id: 'veh_1' }, OWNER, 'cobalt');
    expect(ids).toContain('curated_cobalt');
    expect(ids).not.toContain('curated_spark');
    expect(ids).not.toContain('no_fitment');
  });

  it("another user's vehicle_id lists as if no vehicle were given", async () => {
    const { ids } = await listed({ vehicle_id: 'veh_1' }, 'usr_other');
    const unfiltered = await listed({});
    expect(ids).toEqual(unfiltered.ids);
    expect(ids).toContain('curated_spark');
  });

  it('an anonymous caller never looks a vehicle up', async () => {
    const { ids, prisma } = await listed({ vehicle_id: 'veh_1' }, null);
    expect(prisma.vehicle.findFirst).not.toHaveBeenCalled();
    expect(ids).toEqual((await listed({})).ids);
  });

  it('the lookup excludes soft-deleted garage vehicles', async () => {
    const { prisma } = await listed({ vehicle_id: 'veh_1' }, OWNER);
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'veh_1', userId: OWNER, deletedAt: null },
      }),
    );
  });

  it('legacy GET :id/compatibility answers for the owner only', async () => {
    const prisma = makePrisma('cobalt');
    prisma.catalogPart.findUnique.mockResolvedValue({
      id: 'p1',
      isUniversal: false,
      compatibilities: [],
      fitmentBindings: [{ vehicleModelId: 'cobalt' }],
    });
    const svc = new PartsService(prisma as never, noDiscounts as never);
    const mine = await svc.compatibility('p1', 'veh_1', OWNER);
    const theirs = await svc.compatibility('p1', 'veh_1', 'usr_other');
    expect(mine).toMatchObject({ status: 'fits', source: 'fitment' });
    expect(theirs).toMatchObject({ status: 'maybe' });
  });
});
