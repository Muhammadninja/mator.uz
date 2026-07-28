// Tests for the buyer parts API's KIND-aware filtering, written against the
// `where` clause the service hands Prisma. That is the right assertion surface
// here: the questions being answered are "does a spare-part query still return
// spare parts" and "does an oil filter actually restrict to oils", and both are
// decided entirely by the predicate — not by anything downstream of it.
//
// Covers, in order:
//   • filtering oils by viscosity / oil type / volume,
//   • sorting and free-text search still working after ProductKind existed,
//   • existing spare-part queries NOT silently changing meaning or mixing in oils.

import {
  OilType,
  PartOriginRegion,
  PartVehicleCategory,
  ProductKind,
} from '@prisma/client';
import { PartsService } from './parts.service';
import { ListPartsQueryDto } from './dto/list-parts.query.dto';

/**
 * Prisma stub that records the arguments of every catalogPart call. `findMany`
 * returns nothing — these tests are about the QUERY, not the rows.
 */
function makePrisma() {
  const calls: { findMany?: any; count?: any; groupBy: any[] } = {
    groupBy: [],
  };
  return {
    calls,
    catalogPart: {
      count: jest.fn().mockImplementation((args: unknown) => {
        calls.count = args;
        return Promise.resolve(0);
      }),
      findMany: jest.fn().mockImplementation((args: unknown) => {
        calls.findMany = args;
        return Promise.resolve([]);
      }),
      groupBy: jest.fn().mockImplementation((args: unknown) => {
        calls.groupBy.push(args);
        return Promise.resolve([]);
      }),
      aggregate: jest.fn().mockResolvedValue({ _min: {}, _max: {} }),
    },
    partBrand: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { findUnique: jest.fn().mockResolvedValue(null) },
  };
}

function makeService() {
  const prisma = makePrisma();
  return { svc: new PartsService(prisma as never), prisma };
}

/** Run `list` with a query and return the AND-predicates it built. */
async function whereFor(query: Partial<ListPartsQueryDto>) {
  const { svc, prisma } = makeService();
  await svc.list(query);
  const where = (prisma.calls.findMany as { where: { AND?: unknown[] } }).where;
  return { where, and: (where.AND ?? []) as Record<string, unknown>[] };
}

/** True when some AND-predicate deep-equals `expected`. */
function hasCond(and: Record<string, unknown>[], expected: unknown): boolean {
  return and.some((c) => JSON.stringify(c) === JSON.stringify(expected));
}

describe('PartsService — filtering motor oils', () => {
  it('filters by a single viscosity, matched EXACTLY (not as a substring)', async () => {
    const { and } = await whereFor({ viscosity: ['5W-30'] });
    // `equals`, never `contains` — otherwise "5W-30" would also match "15W-30".
    expect(
      hasCond(and, {
        OR: [{ oilViscosity: { equals: '5W-30', mode: 'insensitive' } }],
      }),
    ).toBe(true);
  });

  it('filters by several viscosities as an OR', async () => {
    const { and } = await whereFor({ viscosity: ['5W-30', '0W-20'] });
    expect(
      hasCond(and, {
        OR: [
          { oilViscosity: { equals: '5W-30', mode: 'insensitive' } },
          { oilViscosity: { equals: '0W-20', mode: 'insensitive' } },
        ],
      }),
    ).toBe(true);
  });

  it('filters by oil type, mapping the wire value to the enum', async () => {
    const { and } = await whereFor({ oil_type: ['synthetic', 'mineral'] });
    expect(
      hasCond(and, {
        oilType: { in: [OilType.SYNTHETIC, OilType.MINERAL] },
      }),
    ).toBe(true);
  });

  it('filters by exact volumes in millilitres', async () => {
    const { and } = await whereFor({ volume_ml: [1000, 4000] });
    expect(hasCond(and, { oilVolumeMl: { in: [1000, 4000] } })).toBe(true);
  });

  it('filters by a volume RANGE (min and max, inclusive)', async () => {
    const { and } = await whereFor({
      volume_ml_min: 1000,
      volume_ml_max: 5000,
    });
    expect(hasCond(and, { oilVolumeMl: { gte: 1000, lte: 5000 } })).toBe(true);
  });

  it('supports an open-ended volume range', async () => {
    const { and } = await whereFor({ volume_ml_min: 20000 });
    expect(hasCond(and, { oilVolumeMl: { gte: 20000 } })).toBe(true);
  });

  it('combines the three filters as AND (each narrows the last)', async () => {
    const { and } = await whereFor({
      viscosity: ['5W-30'],
      oil_type: ['synthetic'],
      volume_ml: [4000],
    });
    expect(hasCond(and, { kind: ProductKind.MOTOR_OIL })).toBe(true);
    expect(hasCond(and, { oilType: { in: [OilType.SYNTHETIC] } })).toBe(true);
    expect(hasCond(and, { oilVolumeMl: { in: [4000] } })).toBe(true);
  });

  it('an oil-attribute filter IMPLIES kind=MOTOR_OIL', async () => {
    for (const q of [
      { viscosity: ['5W-30'] },
      { oil_type: ['mineral'] },
      { volume_ml: [4000] },
      { volume_ml_min: 1000 },
    ]) {
      const { and } = await whereFor(q);
      expect(hasCond(and, { kind: ProductKind.MOTOR_OIL })).toBe(true);
    }
  });

  it('an explicit kind filter is honoured verbatim', async () => {
    const { and } = await whereFor({ kind: ['motor_oil'] });
    expect(hasCond(and, { kind: { in: [ProductKind.MOTOR_OIL] } })).toBe(true);
  });

  it('exposes oil facets only when the query concerns oils', async () => {
    const { svc, prisma } = makeService();

    // A plain listing pays nothing: brandId groupBy only.
    await svc.list({});
    expect(prisma.calls.groupBy).toHaveLength(1);

    // An oil query adds the three attribute groupBys.
    const oil = makeService();
    await oil.svc.list({ kind: ['motor_oil'] });
    const grouped = oil.prisma.calls.groupBy.map(
      (g: { by: string[] }) => g.by[0],
    );
    expect(grouped).toEqual(
      expect.arrayContaining(['oilViscosity', 'oilType', 'oilVolumeMl']),
    );
  });
});

describe('PartsService — search and sort survive ProductKind', () => {
  it('price sorting is unchanged and never mentions kind', async () => {
    const { svc, prisma } = makeService();
    await svc.list({ sort: 'price_asc' });
    expect((prisma.calls.findMany as { orderBy: unknown }).orderBy).toEqual({
      priceUzs: 'asc',
    });

    const desc = makeService();
    await desc.svc.list({ sort: 'price_desc' });
    expect(
      (desc.prisma.calls.findMany as { orderBy: unknown }).orderBy,
    ).toEqual({ priceUzs: 'desc' });
  });

  it('the default sort is still newest-first', async () => {
    const { svc, prisma } = makeService();
    await svc.list({});
    expect((prisma.calls.findMany as { orderBy: unknown }).orderBy).toEqual({
      createdAt: 'desc',
    });
  });

  it('sorting works INSIDE an oil filter (the two compose)', async () => {
    const { svc, prisma } = makeService();
    await svc.list({
      viscosity: ['5W-30'],
      sort: 'price_asc',
    });
    const args = prisma.calls.findMany as { orderBy: unknown; where: unknown };
    expect(args.orderBy).toEqual({ priceUzs: 'asc' });
    expect(JSON.stringify(args.where)).toContain('MOTOR_OIL');
  });

  it('free-text search still matches on title only, for every kind', async () => {
    const { and } = await whereFor({ q: 'фильтр' });
    expect(
      hasCond(and, { title: { contains: 'фильтр', mode: 'insensitive' } }),
    ).toBe(true);
    // No kind predicate is added by a text search — it searches everything.
    expect(JSON.stringify(and)).not.toContain('kind');
  });

  it('pagination is unaffected', async () => {
    const { svc, prisma } = makeService();
    await svc.list({ page: 3, page_size: 10 });
    const args = prisma.calls.findMany as { skip: number; take: number };
    expect(args).toMatchObject({ skip: 20, take: 10 });
  });
});

describe('PartsService — the compatibility endpoint', () => {
  function makeCompatService(part: Record<string, unknown> | null) {
    const prisma = makePrisma();
    (prisma.catalogPart as unknown as { findUnique: jest.Mock }).findUnique =
      jest.fn().mockResolvedValue(part);
    prisma.vehicle.findUnique.mockResolvedValue({
      trimId: 'trim_1',
      engineId: null,
      year: 2020,
      make: { name: 'Chevrolet' },
      model: { name: 'Cobalt' },
    });
    return new PartsService(prisma as never);
  }

  it('answers "fits" for a UNIVERSAL product instead of the "maybe" default', async () => {
    // A motor oil carries no compatibility rows at all, so the generic path
    // would tell the buyer their oil MIGHT not fit their car.
    const svc = makeCompatService({
      id: 'p1',
      isUniversal: true,
      kind: ProductKind.MOTOR_OIL,
      compatibilities: [],
    });

    const out = await svc.compatibility('p1', 'v1');

    expect(out).toMatchObject({
      status: 'fits',
      confidence: 1,
      source: 'universal',
      matched_trims: [],
      matched_engines: [],
    });
  });

  it('still answers "maybe" for a spare part with no compatibility data', async () => {
    const svc = makeCompatService({
      id: 'p2',
      isUniversal: false,
      kind: ProductKind.SPARE_PART,
      compatibilities: [],
    });

    const out = await svc.compatibility('p2', 'v1');

    expect(out.status).toBe('maybe');
    expect(out.confidence).toBe(0);
  });
});

describe('PartsService — spare-part queries do not silently change', () => {
  it('an UNFILTERED listing applies no kind predicate (historical behaviour)', async () => {
    // The pre-ProductKind contract: no kind param → every kind is returned.
    // Nothing may narrow this implicitly.
    const { where, and } = await whereFor({});
    expect(JSON.stringify(where)).not.toContain('kind');
    expect(and.every((c) => !('kind' in c))).toBe(true);
  });

  it('kind=spare_part returns ONLY spare parts (oils are excluded)', async () => {
    const { and } = await whereFor({ kind: ['spare_part'] });
    expect(hasCond(and, { kind: { in: [ProductKind.SPARE_PART] } })).toBe(true);
  });

  it('every legacy spare-part filter still builds its original predicate', async () => {
    const { and } = await whereFor({
      category: 'BRAKES',
      vehicle_category: 'BRAKE_SYSTEM',
      brand: 'brand_gates',
      region: ['korea'],
      gm_only: 'true',
      oem_only: 'true',
      in_stock_only: 'true',
    });
    expect(hasCond(and, { mainCategory: 'BRAKES' })).toBe(true);
    expect(
      hasCond(and, { vehicleCategory: PartVehicleCategory.BRAKE_SYSTEM }),
    ).toBe(true);
    expect(hasCond(and, { brandId: { in: ['brand_gates'] } })).toBe(true);
    expect(
      hasCond(and, { originRegion: { in: [PartOriginRegion.KOREA] } }),
    ).toBe(true);
    expect(hasCond(and, { isGm: true })).toBe(true);
    expect(hasCond(and, { isOem: true })).toBe(true);
    expect(hasCond(and, { inStock: true })).toBe(true);
    // …and none of them dragged in an oil predicate.
    expect(JSON.stringify(and)).not.toContain('oilViscosity');
    expect(JSON.stringify(and)).not.toContain('oilType');
  });

  it('a GM/OEM query cannot return oils, since oils are never flagged GM or OEM', async () => {
    // Oils commit with partNumberType UNKNOWN and no number, so isGm/isOem stay
    // false — the predicate itself is what keeps them out.
    const { and } = await whereFor({ gm_only: 'true' });
    expect(hasCond(and, { isGm: true })).toBe(true);
  });

  it('a garage-vehicle query DOES include oils — they are universal by design', async () => {
    // This is intended, not a leak: a motor oil fits every vehicle, so it must
    // appear for a selected car exactly like any other universal product.
    const { svc, prisma } = makeService();
    prisma.vehicle.findUnique.mockResolvedValue({
      trimId: 'trim_1',
      engineId: null,
      year: 2020,
      make: { name: 'Chevrolet' },
      model: { name: 'Cobalt' },
    });
    await svc.list({ vehicle_id: 'v1' });
    const where = JSON.stringify(
      (prisma.calls.findMany as { where: unknown }).where,
    );
    expect(where).toContain('isUniversal');
  });

  it('make/model filters keep including universal products (oils included)', async () => {
    const { and } = await whereFor({ make: 'Chevrolet' });
    const makeCond = and.find((c) => 'OR' in c) as { OR: unknown[] };
    expect(JSON.stringify(makeCond.OR)).toContain('isUniversal');
  });
});
