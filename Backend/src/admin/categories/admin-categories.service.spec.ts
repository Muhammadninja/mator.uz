// Unit tests for the admin category service methods added to close the spec
// gaps: the flat filterable list (with derived level), get-by-id, activate/
// deactivate, and the children delete-guard. Prisma is mocked — no DB.

import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminCategoriesService } from './admin-categories.service';

// A small forest reused across the list/level tests:
//   other (root) → motorcycle-oil (child)
//   brakes (root)
const NODE = (over: Partial<Record<string, unknown>>) => ({
  id: 'x',
  name: 'X',
  slug: 'x',
  parentId: null,
  sortOrder: 0,
  iconKey: null,
  color: null,
  isActive: true,
  mainCategory: null,
  _count: { parts: 0, products: 0, productDrafts: 0 },
  ...over,
});

const FOREST = [
  NODE({ id: 'brakes', name: 'Brakes', slug: 'brakes', sortOrder: 1 }),
  NODE({ id: 'other', name: 'Другое', slug: 'other', sortOrder: 99 }),
  NODE({ id: 'motorcycle-oil', name: 'Мото', slug: 'motorcycle-oil', parentId: 'other', sortOrder: 1 }),
];

function makePrismaMock() {
  return {
    partCategory: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    },
    catalogPart: { count: jest.fn() },
    product: { count: jest.fn() },
    productDraft: { count: jest.fn() },
  };
}

describe('AdminCategoriesService (gap-closing methods)', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: AdminCategoriesService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new AdminCategoriesService(prisma as never);
  });

  describe('list', () => {
    it('parentId "null" restricts to roots and derives level 0', async () => {
      prisma.partCategory.findMany.mockResolvedValue(FOREST);
      const res = await service.list({ parentId: 'null' });
      expect(res.data.map((n) => n.id)).toEqual(['brakes', 'other']); // ordered by sortOrder
      expect(res.data.every((n) => n.level === 0)).toBe(true);
      expect(res.meta.total).toBe(2);
    });

    it('a concrete parentId lists its children with level 1', async () => {
      prisma.partCategory.findMany.mockResolvedValue(FOREST);
      const res = await service.list({ parentId: 'other' });
      expect(res.data.map((n) => n.id)).toEqual(['motorcycle-oil']);
      expect(res.data[0].level).toBe(1);
    });

    it('level filter selects only nodes at that depth', async () => {
      prisma.partCategory.findMany.mockResolvedValue(FOREST);
      const res = await service.list({ level: 1 });
      expect(res.data.map((n) => n.id)).toEqual(['motorcycle-oil']);
    });

    it('isActive filter is applied', async () => {
      prisma.partCategory.findMany.mockResolvedValue([
        ...FOREST,
        NODE({ id: 'off', name: 'Off', slug: 'off', isActive: false }),
      ]);
      const res = await service.list({ isActive: false });
      expect(res.data.map((n) => n.id)).toEqual(['off']);
    });
  });

  describe('findOne', () => {
    it('returns the node with derived level', async () => {
      prisma.partCategory.findUnique.mockResolvedValue(
        NODE({ id: 'motorcycle-oil', name: 'Мото', slug: 'motorcycle-oil', parentId: 'other' }),
      );
      prisma.partCategory.findMany.mockResolvedValue(
        FOREST.map((n) => ({ id: n.id, parentId: n.parentId })),
      );
      const res = await service.findOne('motorcycle-oil');
      expect(res.data.id).toBe('motorcycle-oil');
      expect(res.data.level).toBe(1);
    });

    it('404s when missing', async () => {
      prisma.partCategory.findUnique.mockResolvedValue(null);
      await expect(service.findOne('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setActive', () => {
    it('activates via isActive=true and returns the node', async () => {
      prisma.partCategory.findUnique.mockResolvedValue({ id: 'other' });
      prisma.partCategory.update.mockResolvedValue(NODE({ id: 'other', name: 'Другое', isActive: true }));
      const res = await service.setActive('other', true);
      expect(prisma.partCategory.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'other' }, data: { isActive: true } }),
      );
      expect(res.data.isActive).toBe(true);
    });

    it('404s when missing', async () => {
      prisma.partCategory.findUnique.mockResolvedValue(null);
      await expect(service.setActive('nope', false)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove (children guard)', () => {
    it('409s when the category has children', async () => {
      prisma.partCategory.findUnique.mockResolvedValue({ id: 'other' });
      prisma.partCategory.count.mockResolvedValue(2); // has children
      await expect(service.remove('other')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.catalogPart.count).not.toHaveBeenCalled(); // short-circuits before parts
    });

    it('409s when supply-side listings point here (deactivate instead)', async () => {
      prisma.partCategory.findUnique.mockResolvedValue({ id: 'motorcycle-oil' });
      prisma.partCategory.count.mockResolvedValue(0); // no children
      prisma.product.count.mockResolvedValue(3); // 3 published listings
      prisma.productDraft.count.mockResolvedValue(0);
      await expect(service.remove('motorcycle-oil')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.catalogPart.count).not.toHaveBeenCalled(); // blocks before the parts path
    });

    it('proceeds to the parts check when there are no children or listings', async () => {
      prisma.partCategory.findUnique.mockResolvedValue({ id: 'leaf' });
      prisma.partCategory.count.mockResolvedValue(0); // no children
      prisma.product.count.mockResolvedValue(0); // no listings
      prisma.productDraft.count.mockResolvedValue(0);
      prisma.catalogPart.count.mockResolvedValue(0); // no parts
      prisma.partCategory.delete.mockResolvedValue({ id: 'leaf' });
      const res = await service.remove('leaf');
      expect(res).toEqual({ success: true, data: { deleted: 'leaf', reassigned: 0 } });
    });
  });
});
