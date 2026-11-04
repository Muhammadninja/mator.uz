// Unit tests for FitmentQueueService — the part-first conveyor. Prisma is
// stubbed per-case (no DB), mirroring fitment-studio.service.spec.ts.
//
// What these pin, in the order the operator meets them:
//   • the queue's row shape, ordering, and the filter → predicate mapping
//   • top300 = the stored fitment_priority ranking (fitment-queue.top300.spec.ts)
//   • bind REPLACING the set (the delete is what makes a correction possible)
//   • the category guard against the REAL taxonomy slugs, both directions
//   • unknown vehicle ids → 400, not an FK 500

import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FitmentQueueService } from './fitment-queue.service';
import { BindPartFitmentDto } from './dto/bind-part-fitment.dto';
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
    // The row-lock query bindPart issues inside its interactive transaction.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  // Array form (queue reads) and interactive form (bindPart) — the callback
  // runs against this same stub. Attached after the literal so the stub keeps
  // its inferred type (a self-reference inside the initializer would not).
  const stub = Object.assign(prisma, {
    $transaction: jest.fn(
      (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    ),
  });
  for (const [model, methods] of Object.entries(over)) {
    Object.assign((stub as Record<string, unknown>)[model] as object, methods);
  }
  return stub;
}

const svc = (prisma: ReturnType<typeof makePrisma>) =>
  new FitmentQueueService(prisma as never);

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

describe('FitmentQueueService.bindPart — empty set, lock, concurrency', () => {
  const PART_ROW = {
    id: 'part_1',
    oemNumbers: [],
    gmNumbers: [],
    category: { slug: 'front-brake-pads', parent: { slug: 'brake-system' } },
  };

  it('an EMPTY set clears this part at THIS node only, atomically', async () => {
    const prisma = makePrisma({
      catalogPart: { findUnique: jest.fn().mockResolvedValue(PART_ROW) },
    });
    const res = await svc(prisma).bindPart({
      partId: 'part_1',
      vehicleModelIds: [],
      nodeKey: 'FRONT_BRAKES',
    } as never);

    expect(prisma.fitmentBinding.deleteMany).toHaveBeenCalledWith({
      where: { partId: 'part_1', nodeId: 'node_fb' },
    });
    expect(prisma.fitmentBinding.createMany).not.toHaveBeenCalled();
    expect(prisma.vehicleModelRef.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(res.boundCount).toBe(0);
  });

  it('takes the part row lock BEFORE deleting, inside the same transaction', async () => {
    const order: string[] = [];
    const prisma = makePrisma({
      catalogPart: { findUnique: jest.fn().mockResolvedValue(PART_ROW) },
      vehicleModelRef: {
        findMany: jest.fn().mockResolvedValue([{ id: 'cobalt' }]),
      },
      fitmentBinding: {
        deleteMany: jest.fn().mockImplementation(() => {
          order.push('delete');
          return Promise.resolve({ count: 0 });
        }),
        createMany: jest.fn().mockImplementation(() => {
          order.push('create');
          return Promise.resolve({ count: 1 });
        }),
      },
    });
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      order.push(strings.join('?').includes('FOR UPDATE') ? 'lock' : 'sql');
      return Promise.resolve([]);
    });
    await svc(prisma).bindPart({
      partId: 'part_1',
      vehicleModelIds: ['cobalt'],
      nodeKey: 'FRONT_BRAKES',
    } as never);
    expect(order).toEqual(['lock', 'delete', 'create']);
  });

  describe('BindPartFitmentDto', () => {
    const parse = (raw: Record<string, unknown>) => {
      const dto = plainToInstance(BindPartFitmentDto, {
        partId: 'part_1',
        nodeKey: 'ENGINE',
        ...raw,
      });
      return { dto, errors: validateSync(dto).map((e) => e.property) };
    };

    it('accepts an empty list (= clear this node)', () => {
      expect(parse({ vehicleModelIds: [] }).errors).toEqual([]);
    });

    it('rejects a blank id instead of silently turning it into an empty set', () => {
      expect(parse({ vehicleModelIds: [''] }).errors).toContain(
        'vehicleModelIds',
      );
      expect(parse({ vehicleModelIds: ['  '] }).errors).toContain(
        'vehicleModelIds',
      );
    });

    it('dedupes and trims ids, keeping order', () => {
      expect(
        parse({ vehicleModelIds: ['cobalt', ' gentra ', 'cobalt'] }).dto
          .vehicleModelIds,
      ).toEqual(['cobalt', 'gentra']);
    });

    it('still requires an array', () => {
      expect(parse({ vehicleModelIds: 'cobalt' }).errors).toContain(
        'vehicleModelIds',
      );
    });
  });

  /**
   * In-memory bindings with transactions SERIALISED the way the part row lock
   * serialises them in PostgreSQL, and every call yielding so concurrent
   * requests genuinely interleave. Proves the replace-set logic under that
   * lock — not PostgreSQL itself.
   */
  function bindingStore() {
    let rows: { partId: string; vehicleModelId: string; nodeId: string }[] = [];
    let queue: Promise<unknown> = Promise.resolve();
    const tick = () => new Promise<void>((r) => setImmediate(r));
    const api = {
      deleteMany: async ({
        where,
      }: {
        where: {
          partId: string;
          nodeId: string;
          vehicleModelId?: { notIn: string[] };
        };
      }) => {
        await tick();
        const notIn = where.vehicleModelId?.notIn;
        rows = rows.filter(
          (r) =>
            !(
              r.partId === where.partId &&
              r.nodeId === where.nodeId &&
              (!notIn || !notIn.includes(r.vehicleModelId))
            ),
        );
        return { count: 0 };
      },
      createMany: async ({ data }: { data: typeof rows }) => {
        await tick();
        for (const d of data) {
          if (
            !rows.some(
              (r) =>
                r.partId === d.partId &&
                r.nodeId === d.nodeId &&
                r.vehicleModelId === d.vehicleModelId,
            )
          ) {
            rows.push(d);
          }
        }
        return { count: data.length };
      },
    };
    const serialise = (fn: () => Promise<unknown>) => {
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    };
    return {
      api,
      serialise,
      models: () => rows.map((r) => r.vehicleModelId).sort(),
    };
  }

  it("two CONCURRENT binds of one part end with exactly ONE request's set — never the union", async () => {
    const store = bindingStore();
    const prisma = makePrisma({
      catalogPart: { findUnique: jest.fn().mockResolvedValue(PART_ROW) },
      vehicleModelRef: {
        findMany: jest
          .fn()
          .mockImplementation(
            ({ where }: { where: { id: { in: string[] } } }) =>
              Promise.resolve(where.id.in.map((id) => ({ id }))),
          ),
      },
      fitmentBinding: {
        deleteMany: jest.fn(store.api.deleteMany),
        createMany: jest.fn(store.api.createMany),
      },
    });
    prisma.$transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) =>
        store.serialise(() => fn(prisma)),
    );

    const bind = (ids: string[]) =>
      svc(prisma).bindPart({
        partId: 'part_1',
        vehicleModelIds: ids,
        nodeKey: 'FRONT_BRAKES',
      } as never);
    await Promise.all([bind(['cobalt', 'gentra']), bind(['spark'])]);

    // Serialised: the later request's set wins outright (last-write-wins).
    expect(store.models()).toEqual(['spark']);
  });

  it('sanity: WITHOUT serialisation the old delete/insert interleaving leaves the union', async () => {
    const store = bindingStore();
    // The pre-fix shape: delete-then-insert per request, no lock, interleaved.
    const oldBind = async (ids: string[]) => {
      await store.api.deleteMany({
        where: {
          partId: 'part_1',
          nodeId: 'node_fb',
          vehicleModelId: { notIn: ids },
        },
      });
      await store.api.createMany({
        data: ids.map((vehicleModelId) => ({
          partId: 'part_1',
          vehicleModelId,
          nodeId: 'node_fb',
        })),
      });
    };
    await Promise.all([oldBind(['cobalt', 'gentra']), oldBind(['spark'])]);
    expect(store.models()).toEqual(['cobalt', 'gentra', 'spark']);
  });
});
