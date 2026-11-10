// LOW-CAT-012: reference caches are busted for exactly the keys a mutation
// changes, after the database write succeeds.

import { AdminBrandsService } from './admin-brands.service';

const brandRow = {
  id: 'chevrolet',
  name: 'Chevrolet',
  logoUrl: null,
  country: null,
  isActive: true,
  comingSoon: false,
  sortOrder: 1,
  _count: { models: 2 },
  createdAt: new Date(),
  updatedAt: new Date(),
};

function setup() {
  const deleted: string[] = [];
  const cache = {
    delete: jest.fn(async (key: string) => void deleted.push(key)),
  };
  const prisma: any = {
    vehicleMake: {
      findUnique: jest.fn().mockResolvedValue(brandRow),
      update: jest.fn().mockResolvedValue(brandRow),
      delete: jest.fn().mockResolvedValue(brandRow),
    },
    vehicleModelRef: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'cobalt' }, { id: 'nexia-3' }]),
      findUnique: jest
        .fn()
        .mockResolvedValue({
          id: 'cobalt',
          makeId: 'chevrolet',
          name: 'Cobalt',
        }),
      delete: jest.fn().mockResolvedValue({}),
    },
    fitmentBinding: {
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn((run: (tx: unknown) => unknown) => run(prisma)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminBrandsService(
    prisma,
    cache as never,
    audit as never,
  );
  return { service, prisma, deleted };
}

describe('reference cache invalidation', () => {
  it('a brand deactivation busts its models list, not only the makes list', async () => {
    const { service, deleted } = setup();
    await service.update('chevrolet', { isActive: false } as never);
    expect(deleted).toEqual([
      'cache:reference:makes',
      'cache:reference:models:chevrolet',
    ]);
  });

  it('a brand rename busts only the makes list; other brands stay cached', async () => {
    const { service, deleted } = setup();
    await service.update('chevrolet', { name: 'Chevy' } as never);
    expect(deleted).toEqual(['cache:reference:makes']);
  });

  it("a brand delete busts its models and every cascaded model's trims", async () => {
    const { service, deleted } = setup();
    await service.remove('chevrolet');
    expect(deleted.sort()).toEqual(
      [
        'cache:reference:makes',
        'cache:reference:models:chevrolet',
        'cache:reference:trims:cobalt',
        'cache:reference:trims:nexia-3',
      ].sort(),
    );
  });

  it("a model delete busts its brand's models list and its own trims", async () => {
    const { service, deleted } = setup();
    await service.removeModel('cobalt');
    expect(deleted).toEqual(
      expect.arrayContaining([
        'cache:reference:models:chevrolet',
        'cache:reference:trims:cobalt',
      ]),
    );
    expect(deleted.some((k) => k.includes('nexia-3'))).toBe(false);
  });

  it('a failed delete invalidates nothing', async () => {
    const { service, prisma, deleted } = setup();
    prisma.vehicleMake.delete.mockRejectedValue(new Error('db down'));
    await expect(service.remove('chevrolet')).rejects.toThrow('db down');
    expect(deleted).toEqual([]);
  });
});
