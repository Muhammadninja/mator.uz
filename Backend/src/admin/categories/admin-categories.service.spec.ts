// Tests for the admin Category-tree console: filtered listing, create/update
// with DERIVED levels, activate/deactivate, the delete guards that protect
// referenced categories, and the cache invalidation that makes an admin edit
// reach the Telegram seller bot.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
  // Фискальные данные — unconfigured by default, the state a category starts in.
  mxik: null,
  packageCodeSingle: null,
  packageCodeSet: null,
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

    await service.create({
      nameRu: 'Brake Pads',
      nameUz: 'Brake Pads',
      nameEn: 'Brake Pads',
      name: 'Brake Pads',
      parentId: 'brakes',
    });

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
    await service.create({
      nameRu: 'Body',
      nameUz: 'Body',
      nameEn: 'Body',
      name: 'Body',
    });
    expect(prisma.partCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: 0 }),
      }),
    );
  });

  it('rejects a duplicate slug under the same tree', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findFirst.mockResolvedValue({ id: 'brakes' });
    await expect(
      service.create({
        nameRu: 'Brakes',
        nameUz: 'Brakes',
        nameEn: 'Brakes',
        name: 'Brakes',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('propagates an unknown parent as 404', async () => {
    const { service, categories } = makeService();
    categories.validateParent.mockRejectedValue(new NotFoundException());
    await expect(
      service.create({
        nameRu: 'X',
        nameUz: 'X',
        nameEn: 'X',
        name: 'X',
        parentId: 'ghost',
      }),
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

// ── Фискальные данные ────────────────────────────────────────────────────────
// A category owns the MXIK and the two Tasnif package codes every product in it
// is fiscalized with. The rule the console must enforce is a property of the ROW
// AFTER the patch, not of the body: "configured" means BOTH an MXIK and a single
// package code, with the set code optional.

describe('fiscal configuration', () => {
  const FISCAL = {
    mxik: '08708005011000000',
    packageCodeSingle: '1417722',
    packageCodeSet: '1417723',
  };

  it('creates a category with one package code', async () => {
    const { service, prisma } = makeService();
    await service.create({
      nameRu: 'Filters',
      nameUz: 'Filters',
      nameEn: 'Filters',
      name: 'Filters',
      mxik: '08421002001000000',
      packageCodeSingle: '1499205',
    });
    expect(prisma.partCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mxik: '08421002001000000',
          packageCodeSingle: '1499205',
        }),
      }),
    );
    // The set code is not named, so nothing is written for it — the column's
    // own null is what "sold in one form" means.
    expect(prisma.partCategory.create.mock.calls[0][0].data).not.toHaveProperty(
      'packageCodeSet',
    );
  });

  it('creates a category with two package codes', async () => {
    const { service, prisma } = makeService();
    await service.create({
      nameRu: 'Brakes',
      nameUz: 'Brakes',
      nameEn: 'Brakes',
      name: 'Brakes',
      ...FISCAL,
    });
    expect(prisma.partCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining(FISCAL),
      }),
    );
  });

  it('creates an UNCONFIGURED category, writing no fiscal columns', async () => {
    const { service, prisma } = makeService();
    await service.create({
      nameRu: 'Turbochargers',
      nameUz: 'Turbochargers',
      nameEn: 'Turbochargers',
      name: 'Turbochargers',
    });
    const data = prisma.partCategory.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('mxik');
    expect(data).not.toHaveProperty('packageCodeSingle');
  });

  it('rejects a package code with no MXIK', async () => {
    const { service } = makeService();
    await expect(
      service.create({
        nameRu: 'Brakes',
        nameUz: 'Brakes',
        nameEn: 'Brakes',
        name: 'Brakes',
        packageCodeSingle: '1417722',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an MXIK with no single package code', async () => {
    const { service } = makeService();
    await expect(
      service.create({
        nameRu: 'Brakes',
        nameUz: 'Brakes',
        nameEn: 'Brakes',
        name: 'Brakes',
        mxik: '08708005011000000',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a SET code without the single code it depends on', async () => {
    const { service } = makeService();
    await expect(
      service.create({
        nameRu: 'Brakes',
        nameUz: 'Brakes',
        nameEn: 'Brakes',
        name: 'Brakes',
        mxik: '08708005011000000',
        packageCodeSet: '1417723',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('adds a set code to an already-configured category', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(
      node({ mxik: FISCAL.mxik, packageCodeSingle: FISCAL.packageCodeSingle }),
    );
    await service.update('brakes', { packageCodeSet: '1417723' });
    // Only the named column is written — the stored MXIK is left alone.
    const data = prisma.partCategory.update.mock.calls[0][0].data;
    expect(data.packageCodeSet).toBe('1417723');
    expect(data).not.toHaveProperty('mxik');
  });

  it('refuses to strip the single code from a configured category', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(node(FISCAL));
    await expect(
      service.update('brakes', { packageCodeSingle: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows clearing the whole configuration at once', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(node(FISCAL));
    await service.update('brakes', {
      mxik: null,
      packageCodeSingle: null,
      packageCodeSet: null,
    });
    expect(prisma.partCategory.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        mxik: null,
        packageCodeSingle: null,
        packageCodeSet: null,
      }),
    );
  });

  it('treats a blank string as "clear", not as a stored empty code', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(node(FISCAL));
    await expect(
      service.update('brakes', { mxik: '', packageCodeSingle: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // …and clearing all three blank-wise is accepted.
    await service.update('brakes', {
      mxik: '',
      packageCodeSingle: '',
      packageCodeSet: '',
    });
    expect(prisma.partCategory.update.mock.calls[0][0].data.mxik).toBeNull();
  });

  it('writes no fiscal column when the body names none', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(node(FISCAL));
    await service.update('brakes', { name: 'Тормоза' });
    const data = prisma.partCategory.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('mxik');
    expect(data).not.toHaveProperty('packageCodeSet');
  });

  it('reports the derived flags the console renders', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(node(FISCAL));
    const { data } = await service.findOne('brakes');
    expect(data).toMatchObject({
      mxik: FISCAL.mxik,
      packageCodeSingle: FISCAL.packageCodeSingle,
      packageCodeSet: FISCAL.packageCodeSet,
      fiscalConfigured: true,
      offersPackageChoice: true,
    });

    prisma.partCategory.findUnique.mockResolvedValue(node());
    const unconfigured = await service.findOne('brakes');
    expect(unconfigured.data).toMatchObject({
      fiscalConfigured: false,
      offersPackageChoice: false,
    });
  });
});
