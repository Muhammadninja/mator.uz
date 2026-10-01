// Unit tests for FitmentQueueService — the part-first conveyor. Prisma is
// stubbed per-case (no DB), mirroring fitment-studio.service.spec.ts.
//
// What these pin, in the order the operator meets them:
//   • the queue's row shape, ordering, and the filter → predicate mapping
//   • top300 = the EXPLICIT business list, in list order, never padded
//   • bind REPLACING the set (the delete is what makes a correction possible)
//   • the category guard against the REAL taxonomy slugs, both directions
//   • unknown vehicle ids → 400, not an FK 500

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FitmentQueueService } from './fitment-queue.service';
import { GetPartsQueueQueryDto } from './dto/get-parts-queue-query.dto';

const QUEUE_ROW = (over: Record<string, unknown> = {}) => ({
  id: 'part_1',
  title: 'Передние тормозные колодки',
  images: ['https://cdn/img.jpg'],
  oemNumbers: ['GM 96484900'],
  gmNumbers: [],
  isOem: true,
  fitmentPriority: 1,
  brand: { name: 'Sangsin' },
  category: { slug: 'front-brake-pads', parent: { slug: 'brake-system' } },
  fitmentBindings: [],
  ...over,
});

function makePrisma(over: Record<string, Record<string, jest.Mock>> = {}) {
  const prisma = {
    catalogPart: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    vehicleNode: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'node_fb', category: 'FRONT_BRAKES' }),
    },
    vehicleModelRef: { findMany: jest.fn().mockResolvedValue([]) },
    fitmentBinding: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  for (const [model, methods] of Object.entries(over)) {
    Object.assign(
      (prisma as Record<string, unknown>)[model] as object,
      methods,
    );
  }
  return prisma;
}

const svc = (
  prisma: ReturnType<typeof makePrisma>,
  top300: readonly unknown[] = [],
) => new FitmentQueueService(prisma as never, top300);

const query = (
  over: Partial<GetPartsQueueQueryDto> = {},
): GetPartsQueueQueryDto => ({ limit: 300, filter: 'all', ...over });

describe('FitmentQueueService.getPartsQueue', () => {
  it('maps a row to the client contract and echoes meta.total', async () => {
    const prisma = makePrisma({
      catalogPart: {
        count: jest.fn().mockResolvedValue(42),
        findMany: jest.fn().mockResolvedValue([
          QUEUE_ROW({
            fitmentBindings: [
              { vehicleModelId: 'cobalt', node: { category: 'FRONT_BRAKES' } },
              { vehicleModelId: 'gentra', node: { category: 'FRONT_BRAKES' } },
            ],
          }),
        ]),
      },
    });

    const res = await svc(prisma).getPartsQueue(query());

    expect(res.meta.total).toBe(42);
    expect(res.data[0]).toEqual({
      id: 'part_1',
      name: 'Передние тормозные колодки',
      brand: 'Sangsin',
      sku: null,
      oem: 'GM 96484900',
      oemNumbers: ['GM 96484900'],
      tag: 'OEM',
      category: 'front-brake-pads',
      suggestedNodeCategory: 'FRONT_BRAKES',
      imageUrl: 'https://cdn/img.jpg',
      // ALL bindings, as an array — the binder pre-fills from this, so a count
      // would make a mis-binding uncorrectable.
      mappedVehicleModelIds: ['cobalt', 'gentra'],
      top300Position: null,
      nodeKey: 'FRONT_BRAKES',
    });
  });

  it('orders by [fitmentPriority asc nulls last, id asc] so rows never reshuffle', async () => {
    const prisma = makePrisma();
    await svc(prisma).getPartsQueue(query());
    expect(prisma.catalogPart.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { fitmentPriority: { sort: 'asc', nulls: 'last' } },
          { id: 'asc' },
        ],
        take: 300,
      }),
    );
  });

  it('filter=unmapped is vehicle-agnostic (bound to NOTHING, not "not this car")', async () => {
    const prisma = makePrisma();
    await svc(prisma).getPartsQueue(query({ filter: 'unmapped' }));
    expect(prisma.catalogPart.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { fitmentBindings: { none: {} } } }),
    );
  });

  it('search is ONE OR across name + brand + oem + gm + id', async () => {
    const prisma = makePrisma();
    await svc(prisma).getPartsQueue(query({ search: '  SP1234 ' }));
    const calls = prisma.catalogPart.findMany.mock.calls as {
      where: { OR: unknown[] };
    }[][];
    const where = calls[0][0].where;
    expect(where.OR).toEqual([
      { title: { contains: 'SP1234', mode: 'insensitive' } },
      { brand: { name: { contains: 'SP1234', mode: 'insensitive' } } },
      { oemNumbers: { has: 'SP1234' } },
      { gmNumbers: { has: 'SP1234' } },
      { id: { contains: 'SP1234', mode: 'insensitive' } },
    ]);
  });

  it('falls back to gmNumbers for the OEM echo and tags an aftermarket part', async () => {
    const prisma = makePrisma({
      catalogPart: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            QUEUE_ROW({ oemNumbers: [], gmNumbers: ['GM 123'], isOem: false }),
          ]),
      },
    });
    const res = await svc(prisma).getPartsQueue(query());
    expect(res.data[0].oem).toBe('GM 123');
    expect(res.data[0].tag).toBe('AFTER');
  });
});

describe('FitmentQueueService.bindPart', () => {
  const dto = (over: Record<string, unknown> = {}) =>
    ({
      partId: 'part_1',
      vehicleModelIds: ['cobalt', 'gentra'],
      nodeKey: 'FRONT_BRAKES',
      ...over,
    }) as never;

  function bindPrisma(over: Record<string, Record<string, jest.Mock>> = {}) {
    return makePrisma({
      catalogPart: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'part_1',
          oemNumbers: ['GM 96484900'],
          gmNumbers: [],
          category: {
            slug: 'front-brake-pads',
            parent: { slug: 'brake-system' },
          },
        }),
      },
      vehicleModelRef: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'cobalt' }, { id: 'gentra' }]),
      },
      ...over,
    });
  }

  it('REPLACES the set: deletes this part/node rows outside the payload, then creates', async () => {
    const prisma = bindPrisma();
    const res = await svc(prisma).bindPart(dto());

    expect(prisma.fitmentBinding.deleteMany).toHaveBeenCalledWith({
      where: {
        partId: 'part_1',
        nodeId: 'node_fb',
        vehicleModelId: { notIn: ['cobalt', 'gentra'] },
      },
    });
    expect(prisma.fitmentBinding.createMany).toHaveBeenCalledWith({
      data: [
        { partId: 'part_1', vehicleModelId: 'cobalt', nodeId: 'node_fb' },
        { partId: 'part_1', vehicleModelId: 'gentra', nodeId: 'node_fb' },
      ],
      skipDuplicates: true,
    });
    // Both writes in ONE transaction — a partial write would make the client's
    // optimistic rollback a lie.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      partId: 'part_1',
      boundCount: 2,
      oemNumbers: ['GM 96484900'],
    });
  });

  it('rejects a KNOWN category mismatch with 400 (motor oil on a brake node)', async () => {
    const prisma = bindPrisma({
      catalogPart: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'part_oil',
          oemNumbers: [],
          gmNumbers: [],
          category: {
            slug: 'synthetic-motor-oil',
            parent: { slug: 'motor-oil' },
          },
        }),
      },
    });
    await expect(
      svc(prisma).bindPart(dto({ partId: 'part_oil' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.fitmentBinding.createMany).not.toHaveBeenCalled();
  });

  it('allows a category no node claims (accessories) instead of blocking the operator', async () => {
    const prisma = bindPrisma({
      catalogPart: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'part_mat',
          oemNumbers: [],
          gmNumbers: [],
          category: {
            slug: 'floor-mats',
            parent: { slug: 'tuning-and-accessories' },
          },
        }),
      },
    });
    await expect(
      svc(prisma).bindPart(dto({ partId: 'part_mat' })),
    ).resolves.toMatchObject({
      boundCount: 2,
    });
  });

  it('rejects unknown vehicle model ids with 400 rather than an FK 500', async () => {
    const prisma = bindPrisma({
      vehicleModelRef: {
        findMany: jest.fn().mockResolvedValue([{ id: 'cobalt' }]),
      },
    });
    await expect(svc(prisma).bindPart(dto())).rejects.toThrow(/gentra/);
    expect(prisma.fitmentBinding.deleteMany).not.toHaveBeenCalled();
  });

  it('says the nodes are unseeded instead of failing on the FK', async () => {
    const prisma = bindPrisma({
      vehicleNode: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    await expect(svc(prisma).bindPart(dto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('is idempotent: the same call twice writes the same rows and reports the same count', async () => {
    const prisma = bindPrisma();
    const a = await svc(prisma).bindPart(dto());
    const b = await svc(prisma).bindPart(dto());
    expect(a).toEqual(b);
    const calls = prisma.fitmentBinding.createMany.mock.calls as unknown[][];
    expect(calls[0][0]).toEqual(calls[1][0]);
  });
});

describe('FitmentQueueService — explicit business TOP-300 (filter=top300)', () => {
  const LIST = ['part_30', 'part_10', 'part_20', 'part_ghost'];

  /**
   * findMany stub honouring the two top300 reads: the `select: { id }` probe
   * returns the listed ids that "exist", the row query returns full rows — in
   * the given (deliberately shuffled) database order.
   */
  function top300Prisma(rows: ReturnType<typeof QUEUE_ROW>[]) {
    return makePrisma({
      catalogPart: {
        findMany: jest
          .fn()
          .mockImplementation(
            (args: { where: unknown; select: Record<string, unknown> }) => {
              // Honour `id IN (…)` like the database would (search is not
              // evaluated here — those tests assert the predicate instead).
              const w = args.where as {
                id?: { in: string[] };
                AND?: { id?: { in: string[] } }[];
              };
              const ids = w.id?.in ?? w.AND?.[0]?.id?.in ?? [];
              const hit = rows.filter((r) => ids.includes(r.id));
              return Promise.resolve(
                Object.keys(args.select).length === 1
                  ? hit.map((r) => ({ id: r.id }))
                  : hit,
              );
            },
          ),
      },
    });
  }

  // DB order is reversed AND salesCount/priority favour the wrong rows: the
  // queue must still follow the list.
  const ROWS = [
    QUEUE_ROW({ id: 'part_20', fitmentPriority: 1, salesCount: 999 }),
    QUEUE_ROW({ id: 'part_10', fitmentPriority: 2, salesCount: 500 }),
    QUEUE_ROW({ id: 'part_30', fitmentPriority: null, salesCount: 0 }),
  ];

  it('returns exactly the listed parts, in list order', async () => {
    const prisma = top300Prisma(ROWS);
    const res = await svc(prisma, LIST).getPartsQueue(
      query({ filter: 'top300' }),
    );
    expect(res.data.map((r) => r.id)).toEqual([
      'part_30',
      'part_10',
      'part_20',
    ]);
    expect(res.data.map((r) => r.top300Position)).toEqual([1, 2, 3]);
  });

  it('queries ONLY the listed ids — never fitmentPriority, sales or rating', async () => {
    const prisma = top300Prisma(ROWS);
    await svc(prisma, LIST).getPartsQueue(query({ filter: 'top300' }));
    const calls = prisma.catalogPart.findMany.mock.calls as [
      { where: unknown; orderBy?: unknown },
    ][];
    for (const [args] of calls) {
      // Membership in the list is the only predicate, and the database is
      // never asked to order anything — the list order is applied in memory.
      expect(args.where).toEqual({ id: { in: LIST } });
      expect(args.orderBy).toBeUndefined();
      expect(JSON.stringify(args.where)).not.toMatch(
        /fitmentPriority|salesCount|ratingAvg|reviewCount/,
      );
    }
    expect(prisma.catalogPart.count).not.toHaveBeenCalled();
  });

  it('reports a listed id that does not exist instead of substituting another part', async () => {
    const prisma = top300Prisma(ROWS);
    const res = await svc(prisma, LIST).getPartsQueue(
      query({ filter: 'top300' }),
    );
    expect(res.data).toHaveLength(3);
    expect(res.meta).toEqual({
      total: 3,
      top300: {
        listSize: 4,
        targetSize: 300,
        resolved: 3,
        missing: ['part_ghost'],
        duplicates: [],
        invalid: [],
      },
    });
  });

  it('an EMPTY list is an empty queue — no fallback to unmapped', async () => {
    const prisma = top300Prisma(ROWS);
    const res = await svc(prisma, []).getPartsQueue(
      query({ filter: 'top300' }),
    );
    expect(res.data).toEqual([]);
    expect(res.meta.total).toBe(0);
    expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
  });

  it('a duplicated id is used once (first position) and reported', async () => {
    const prisma = top300Prisma(ROWS);
    const res = await svc(prisma, [
      'part_10',
      'part_20',
      'part_10',
    ]).getPartsQueue(query({ filter: 'top300' }));
    expect(res.data.map((r) => r.id)).toEqual(['part_10', 'part_20']);
    expect(res.meta.top300?.duplicates).toEqual(['part_10']);
  });

  it('binding a part (fitment changes) does not move it in the list', async () => {
    const before = await svc(top300Prisma(ROWS), LIST).getPartsQueue(
      query({ filter: 'top300' }),
    );
    const bound = ROWS.map((r) =>
      r.id === 'part_10'
        ? {
            ...r,
            fitmentBindings: [
              { vehicleModelId: 'cobalt', node: { category: 'ENGINE' } },
            ],
          }
        : r,
    );
    const after = await svc(top300Prisma(bound as never), LIST).getPartsQueue(
      query({ filter: 'top300' }),
    );
    expect(after.data.map((r) => r.id)).toEqual(before.data.map((r) => r.id));
    expect(after.data[1].mappedVehicleModelIds).toEqual(['cobalt']);
  });

  it('search narrows within the list and keeps list order', async () => {
    const prisma = top300Prisma(ROWS);
    await svc(prisma, LIST).getPartsQueue(
      query({ filter: 'top300', search: 'pads' }),
    );
    const calls = prisma.catalogPart.findMany.mock.calls as [
      { where: unknown },
    ][];
    const { AND } = calls[1][0].where as { AND: Record<string, unknown>[] };
    expect(AND[0]).toEqual({ id: { in: LIST } });
    expect(Array.isArray(AND[1].OR)).toBe(true);
  });

  it('filter=unmapped is unaffected by the list', async () => {
    const prisma = makePrisma();
    await svc(prisma, LIST).getPartsQueue(query({ filter: 'unmapped' }));
    expect(prisma.catalogPart.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { fitmentBindings: { none: {} } } }),
    );
  });

  it('a row outside the list reports top300Position null', async () => {
    const prisma = makePrisma({
      catalogPart: {
        findMany: jest.fn().mockResolvedValue([QUEUE_ROW({ id: 'part_x' })]),
      },
    });
    const res = await svc(prisma, LIST).getPartsQueue(query({ filter: 'all' }));
    expect(res.data[0].top300Position).toBeNull();
  });
});
