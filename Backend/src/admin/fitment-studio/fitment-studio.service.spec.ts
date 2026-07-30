// Unit tests for FitmentStudioService — the admin 3D Fitment Studio. Prisma is
// stubbed per-case (no DB), mirroring src/catalog/parts/check-compatibility.spec.ts.
// We assert: getNodes grouping + completionStatus (EMPTY/PARTIAL/COMPLETE, incl.
// the OEM→COMPLETE rule), the category guard, bind upsert + OEM echo, unbind's
// idempotent deleteMany, and listVehicles make/model/engine='' mapping.

import { BadRequestException } from '@nestjs/common';
import { FitmentStudioService } from './fitment-studio.service';

type PartRow = {
  id: string;
  title: string;
  brand: { name: string } | null;
  priceUzs: number;
  oemNumbers: string[];
};

const PART = (over: Partial<PartRow> = {}): PartRow => ({
  id: 'part_stock_6',
  title: 'Front brake pad set',
  brand: { name: 'Bosch' },
  priceUzs: 250000,
  oemNumbers: [],
  ...over,
});

// A minimal Prisma double. Each model method defaults to a jest.fn resolving to
// a sensible empty value; individual tests override what they exercise.
function makePrisma(over: Record<string, Record<string, jest.Mock>> = {}) {
  const prisma = {
    vehicleModelRef: {
      findUnique: jest.fn().mockResolvedValue({ id: 'cobalt' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    vehicleNode: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    catalogPart: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    fitmentBinding: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // $transaction runs the array of "operations" — but our stubs are already
    // resolved promises, so just await them all.
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  for (const [model, methods] of Object.entries(over)) {
    Object.assign((prisma as Record<string, unknown>)[model] as object, methods);
  }
  return prisma;
}

function svcWith(prisma: ReturnType<typeof makePrisma>) {
  return new FitmentStudioService(prisma as never);
}

const NODE = (over: Partial<{ id: string; category: string; name: string }> = {}) => ({
  id: 'node_brakes_front',
  category: 'FRONT_BRAKES',
  name: 'Передние тормоза',
  positionX: 0.86,
  positionY: 0.34,
  positionZ: 1.3,
  ...over,
});

describe('FitmentStudioService.getNodes — grouping + completionStatus', () => {
  it('EMPTY when a node has no bindings', async () => {
    const prisma = makePrisma({
      vehicleNode: { findMany: jest.fn().mockResolvedValue([NODE({ id: 'n1' })]) },
      fitmentBinding: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const [node] = await svcWith(prisma).getNodes('cobalt');
    expect(node.completionStatus).toBe('EMPTY');
    expect(node.totalMappedParts).toBe(0);
    expect(node.parts).toEqual([]);
  });

  it('PARTIAL when 1-3 parts and none carry an OEM', async () => {
    const prisma = makePrisma({
      vehicleNode: { findMany: jest.fn().mockResolvedValue([NODE({ id: 'n1' })]) },
      fitmentBinding: {
        findMany: jest.fn().mockResolvedValue([
          { nodeId: 'n1', status: 'EXACT_MATCH', part: PART({ oemNumbers: [] }) },
          { nodeId: 'n1', status: 'MAYBE', part: PART({ id: 'part_2', oemNumbers: [] }) },
        ]),
      },
    });
    const [node] = await svcWith(prisma).getNodes('cobalt');
    expect(node.totalMappedParts).toBe(2);
    expect(node.completionStatus).toBe('PARTIAL');
    // status is echoed on each mapped part
    expect(node.parts[0]).toMatchObject({ status: 'EXACT_MATCH', tag: 'AFTER' });
  });

  it('COMPLETE via the OEM rule even with a single bound part', async () => {
    const prisma = makePrisma({
      vehicleNode: { findMany: jest.fn().mockResolvedValue([NODE({ id: 'n1' })]) },
      fitmentBinding: {
        findMany: jest.fn().mockResolvedValue([
          { nodeId: 'n1', status: 'EXACT_MATCH', part: PART({ oemNumbers: ['96484900'] }) },
        ]),
      },
    });
    const [node] = await svcWith(prisma).getNodes('cobalt');
    expect(node.totalMappedParts).toBe(1);
    expect(node.completionStatus).toBe('COMPLETE');
    expect(node.parts[0]).toMatchObject({ oem: '96484900', tag: 'OEM' });
  });

  it('COMPLETE via count (>3 parts, no OEM) and groups bindings to the right node', async () => {
    const four = [0, 1, 2, 3].map((i) => ({
      nodeId: 'n1',
      status: 'EXACT_MATCH',
      part: PART({ id: `part_${i}`, oemNumbers: [] }),
    }));
    const prisma = makePrisma({
      vehicleNode: {
        findMany: jest.fn().mockResolvedValue([NODE({ id: 'n1' }), NODE({ id: 'n2', category: 'ENGINE' })]),
      },
      fitmentBinding: { findMany: jest.fn().mockResolvedValue(four) },
    });
    const nodes = await svcWith(prisma).getNodes('cobalt');
    const n1 = nodes.find((n) => n.id === 'n1')!;
    const n2 = nodes.find((n) => n.id === 'n2')!;
    expect(n1.completionStatus).toBe('COMPLETE');
    expect(n1.totalMappedParts).toBe(4);
    // the other node got none of the bindings
    expect(n2.completionStatus).toBe('EMPTY');
    expect(n2.totalMappedParts).toBe(0);
  });
});

describe('FitmentStudioService.bind — category guard + upsert + OEM echo', () => {
  it('rejects a mismatched category slug with BadRequestException', async () => {
    const prisma = makePrisma({
      vehicleNode: { findUnique: jest.fn().mockResolvedValue(NODE({ category: 'FRONT_BRAKES' })) },
      catalogPart: {
        findUnique: jest.fn().mockResolvedValue({
          ...PART(),
          category: { slug: 'oils' }, // not allowed on FRONT_BRAKES
        }),
      },
    });
    await expect(
      svcWith(prisma).bind({ productId: 'part_stock_6', vehicleModelId: 'cobalt', nodeId: 'node_brakes_front' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.fitmentBinding.upsert).not.toHaveBeenCalled();
  });

  it('upserts on the composite key and echoes the part OEM numbers', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = makePrisma({
      vehicleNode: { findUnique: jest.fn().mockResolvedValue(NODE({ category: 'FRONT_BRAKES' })) },
      catalogPart: {
        findUnique: jest.fn().mockResolvedValue({
          ...PART({ oemNumbers: ['96484900', '96484901'] }),
          category: { slug: 'brakes' }, // allowed on FRONT_BRAKES
        }),
      },
      fitmentBinding: { upsert, findMany: jest.fn().mockResolvedValue([]) },
    });
    const res = await svcWith(prisma).bind({
      productId: 'part_stock_6',
      vehicleModelId: 'cobalt',
      nodeId: 'node_brakes_front',
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          partId_vehicleModelId_nodeId: {
            partId: 'part_stock_6',
            vehicleModelId: 'cobalt',
            nodeId: 'node_brakes_front',
          },
        },
        create: expect.objectContaining({ partId: 'part_stock_6', status: 'EXACT_MATCH' }),
      }),
    );
    expect(res.oemNumbers).toEqual(['96484900', '96484901']);
    expect(res.node).toMatchObject({ id: 'node_brakes_front', completionStatus: 'EMPTY' });
  });

  it('allows binding when the part category cannot be resolved to a slug', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = makePrisma({
      vehicleNode: { findUnique: jest.fn().mockResolvedValue(NODE({ category: 'FRONT_BRAKES' })) },
      catalogPart: {
        findUnique: jest.fn().mockResolvedValue({ ...PART(), category: { slug: null } }),
      },
      fitmentBinding: { upsert, findMany: jest.fn().mockResolvedValue([]) },
    });
    await svcWith(prisma).bind({ productId: 'part_stock_6', vehicleModelId: 'cobalt', nodeId: 'node_brakes_front' });
    expect(upsert).toHaveBeenCalled();
  });
});

describe('FitmentStudioService.unbind — idempotent deleteMany', () => {
  it('calls deleteMany with the exact triple and never throws when absent', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = makePrisma({
      fitmentBinding: { deleteMany, findMany: jest.fn().mockResolvedValue([]) },
    });
    const res = await svcWith(prisma).unbind({
      productId: 'part_stock_6',
      vehicleModelId: 'cobalt',
      nodeId: 'node_brakes_front',
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { partId: 'part_stock_6', vehicleModelId: 'cobalt', nodeId: 'node_brakes_front' },
    });
    expect(res.node).toMatchObject({ id: 'node_brakes_front', totalMappedParts: 0, completionStatus: 'EMPTY' });
  });
});

describe('FitmentStudioService.listVehicles — make/model/engine mapping', () => {
  it('maps make.name → make, name → model, engine → "" and preserves order', async () => {
    const prisma = makePrisma({
      vehicleModelRef: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'cobalt', name: 'Cobalt', make: { name: 'Chevrolet' } },
          { id: 'lacetti', name: 'Lacetti', make: { name: 'Chevrolet' } },
        ]),
      },
    });
    const rows = await svcWith(prisma).listVehicles();
    expect(rows).toEqual([
      { id: 'cobalt', make: 'Chevrolet', model: 'Cobalt', engine: '' },
      { id: 'lacetti', make: 'Chevrolet', model: 'Lacetti', engine: '' },
    ]);
  });
});
