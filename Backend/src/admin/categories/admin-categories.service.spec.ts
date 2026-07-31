// Tests for the admin Category-tree console: filtered listing, create/update
// with DERIVED levels, activate/deactivate, the delete guards that protect
// referenced categories, and the cache invalidation that makes an admin edit
// reach the Telegram seller bot.

import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminCategoriesService } from './admin-categories.service';
import { ListCategoriesQueryDto } from './dto/list-categories.query.dto';

const node = (over: Record<string, unknown> = {}) => ({
  id: 'brakes',
  name: 'Brakes',
  slug: 'brakes',
  parentId: 'brake-system',
  level: 1,
  sortOrder: 0,
  iconKey: null,
  color: null,
  isActive: true,
  mainCategory: null,
  _count: { parts: 0, products: 0, drafts: 0 },
  ...over,
});

function makePrismaMock() {
  return {
    partCategory: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(node()),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(node()),
      update: jest.fn().mockResolvedValue(node()),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn().mockResolvedValue(node()),
      count: jest.fn().mockResolvedValue(0),
    },
    product: { count: jest.fn().mockResolvedValue(0) },
    productDraft: { count: jest.fn().mockResolvedValue(0) },
    catalogPart: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn().mockResolvedValue([{ count: 0 }]),
  };
}

function makeCategoriesMock() {
  return {
    validateParent: jest.fn().mockResolvedValue(1),
    validateMove: jest.fn().mockResolvedValue(1),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService() {
  const prisma = makePrismaMock();
  const categories = makeCategoriesMock();
  const service = new AdminCategoriesService(
    prisma as never,
    categories as never,
  );
  return { service, prisma, categories };
}

describe('GET /v1/admin/categories (list)', () => {
  it('applies parentId / level / isActive filters', async () => {
    const { service, prisma } = makeService();
    const query: ListCategoriesQueryDto = {
      parentId: 'brake-system',
      level: 1,
      isActive: true,
    };
    await service.list(query);
    expect(prisma.partCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { parentId: 'brake-system', level: 1, isActive: true },
      }),
    );
  });

  it('treats parentId="null" as "root categories only"', async () => {
    const { service, prisma } = makeService();
    await service.list({ parentId: 'null' });
    expect(prisma.partCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { parentId: null } }),
    );
  });

  it('applies no parent filter when parentId is omitted', async () => {
    const { service, prisma } = makeService();
    await service.list({});
    expect(prisma.partCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});

describe('POST /v1/admin/categories (create)', () => {
  it('DERIVES the level from the parent and busts the cache', async () => {
    const { service, prisma, categories } = makeService();
    categories.validateParent.mockResolvedValue(2);

    await service.create({ name: 'Brake Pads', parentId: 'brakes' });

    expect(categories.validateParent).toHaveBeenCalledWith('brakes');
    expect(prisma.partCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ id: 'brake-pads', level: 2 }),
      }),
    );
    expect(categories.invalidate).toHaveBeenCalledWith('brakes');
  });

  it('creates a root at level 0', async () => {
    const { service, prisma, categories } = makeService();
    categories.validateParent.mockResolvedValue(0);
    await service.create({ name: 'Body' });
    expect(prisma.partCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: 0 }),
      }),
    );
  });

  it('rejects a duplicate slug under the same tree', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findFirst.mockResolvedValue({ id: 'brakes' });
    await expect(service.create({ name: 'Brakes' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('propagates an unknown parent as 404', async () => {
    const { service, categories } = makeService();
    categories.validateParent.mockRejectedValue(new NotFoundException());
    await expect(
      service.create({ name: 'X', parentId: 'ghost' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PATCH /v1/admin/categories/:id (update)', () => {
  it('routes a parent change through the cycle guard and re-derives the level', async () => {
    const { service, prisma, categories } = makeService();
    categories.validateMove.mockResolvedValue(2);

    await service.update('brakes', { parentId: 'maintenance-and-fluids' });

    expect(categories.validateMove).toHaveBeenCalledWith(
      'brakes',
      'maintenance-and-fluids',
    );
    expect(prisma.partCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: 2 }),
      }),
    );
    // The OLD parent, the NEW parent, and the moved node's OWN child-list key
    // (a seller standing on it must not keep reading the pre-move children).
    expect(categories.invalidate).toHaveBeenCalledWith(
      'brake-system',
      'maintenance-and-fluids',
      'brakes',
    );
  });

  it('writes only the provided fields', async () => {
    const { service, prisma } = makeService();
    await service.update('brakes', { name: 'Тормоза' });
    expect(prisma.partCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'Тормоза' } }),
    );
  });

  it('404s on an unknown category', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(null);
    await expect(service.update('ghost', { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('activate / deactivate', () => {
  it.each([
    ['activate', true],
    ['deactivate', false],
  ])('%s writes isActive=%s and busts the cache', async (_label, isActive) => {
    const { service, prisma, categories } = makeService();
    await service.setActive('brakes', isActive);
    expect(prisma.partCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive } }),
    );
    // The parent's child list AND this node's own: deactivating a parent must
    // not leave the bot serving its children from cache.
    expect(categories.invalidate).toHaveBeenCalledWith(
      'brake-system',
      'brakes',
    );
  });

  it('404s on an unknown category', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(null);
    await expect(service.setActive('ghost', false)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('DELETE guards (deactivation is the preferred path)', () => {
  it('refuses to delete a category referenced by listings', async () => {
    const { service, prisma } = makeService();
    prisma.product.count.mockResolvedValue(3);
    await expect(service.remove('brakes')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.partCategory.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete a category referenced by drafts', async () => {
    const { service, prisma } = makeService();
    prisma.productDraft.count.mockResolvedValue(1);
    await expect(service.remove('brakes')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses to delete a category that still has children', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.count.mockResolvedValue(2);
    await expect(service.remove('brake-system')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses to delete the Uncategorized fallback bucket', async () => {
    const { service } = makeService();
    await expect(service.remove('cat_uncategorized')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('deletes an unreferenced leaf and busts the cache', async () => {
    const { service, prisma, categories } = makeService();
    const res = await service.remove('brakes');
    expect(prisma.partCategory.delete).toHaveBeenCalledWith({
      where: { id: 'brakes' },
    });
    expect(categories.invalidate).toHaveBeenCalledWith('brake-system');
    expect(res).toEqual({
      success: true,
      data: { deleted: 'brakes', reassigned: 0 },
    });
  });
});
