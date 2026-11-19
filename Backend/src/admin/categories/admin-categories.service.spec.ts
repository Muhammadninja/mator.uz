// Tests for the admin Category-tree console: filtered listing, create/update
// with DERIVED levels, activate/deactivate, the subtree delete and the guards
// that protect what depends on it, and the cache invalidation that makes an admin edit
// reach the Telegram seller bot.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PackageForm } from '@prisma/client';
import { listingTypeForCategory } from '../../catalog/categories/category-map';
import { REPRESENTATIVE_ONLY_MXIK } from '../../common/fiscal.util';
import { buildFiscalItem } from '../../orders/webhooks/payme-fiscal.util';
import { presentAdminCategoryNode } from './admin-categories.presenter';
import {
  AdminCategoriesService,
  CategoryDeleteConflict,
} from './admin-categories.service';
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
  packageCodeBox: null,
  _count: {
    parts: 0,
    products: 0,
    productsVehicle: 0,
    drafts: 0,
    draftsVehicle: 0,
  },
  ...over,
});

function makePrismaMock() {
  const prisma = {
    partCategory: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(node()),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(node()),
      update: jest.fn().mockResolvedValue(node()),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn().mockResolvedValue(node()),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    product: { count: jest.fn().mockResolvedValue(0) },
    productDraft: { count: jest.fn().mockResolvedValue(0) },
    sale: { findMany: jest.fn().mockResolvedValue([]) },
    catalogPart: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
    },
    // The row-lock read in remove(): the row exists, under 'brake-system'.
    $queryRaw: jest
      .fn()
      .mockResolvedValue([
        { id: 'old-pads', parent_id: 'brake-system', name: 'Old pads' },
      ]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    // Both forms, against this same mock: `tx.x.y` === `prisma.x.y`.
    $transaction: jest.fn((arg: unknown): unknown =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prisma)
        : Promise.all(arg as unknown[]),
    ),
  };
  return prisma;
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
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    recordMany: jest.fn().mockResolvedValue(undefined),
  };
  const transfers = { drainForDelete: jest.fn().mockResolvedValue(null) };
  const service = new AdminCategoriesService(
    prisma as never,
    categories as never,
    audit as never,
    transfers as never,
  );
  return { service, prisma, categories, audit, transfers };
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

    expect(categories.validateParent).toHaveBeenCalledWith(
      'brakes',
      expect.anything(),
    );
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
      expect.anything(),
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

describe('changing a slug', () => {
  it.each([
    ['a load-bearing category', 'brakes', 'brakes'],
    [
      'a category Fitment Studio binds by slug',
      'front-brake-pads',
      'front-brake-pads',
    ],
  ])('refuses for %s', async (_label, id, slug) => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(node({ id, slug }));

    await expect(
      service.update(id, { slug: 'renamed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.partCategory.update).not.toHaveBeenCalled();
  });

  it('allows an ordinary category, and checks both columns for a clash', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(
      node({ id: 'custom', slug: 'custom' }),
    );

    await service.update('custom', { slug: 'renamed' });

    expect(prisma.partCategory.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ slug: 'renamed' }, { id: 'renamed' }],
        NOT: { id: 'custom' },
      },
      select: { id: true },
    });
    expect(prisma.partCategory.update).toHaveBeenCalledTimes(1);
  });

  it('re-sending the slug it already has is no change at all', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(
      node({ id: 'brakes', slug: 'brakes' }),
    );

    await service.update('brakes', { slug: 'brakes', nameEn: 'Brakes!' });

    expect(prisma.partCategory.update).toHaveBeenCalledTimes(1);
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

describe('DELETE: a category goes with its subtree, its contents moved first', () => {
  /** The 409's machine code, which is what the console branches on. */
  const conflictCode = async (run: Promise<unknown>) => {
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    return ((err as ConflictException).getResponse() as { code?: string }).code;
  };

  /** old-pads → (front → front-left), rear; under brake-system. */
  const SUBTREE = [
    { id: 'old-pads', parentId: 'brake-system' },
    { id: 'front', parentId: 'old-pads' },
    { id: 'rear', parentId: 'old-pads' },
    { id: 'front-left', parentId: 'front' },
  ];
  const lockedRows = (edges: { id: string; parentId: string | null }[]) =>
    edges.map((e) => ({ id: e.id, parent_id: e.parentId, name: e.id }));

  const withSubtree = () => {
    const made = makeService();
    made.prisma.partCategory.findMany.mockResolvedValue(SUBTREE);
    made.prisma.$queryRaw.mockResolvedValue(lockedRows(SUBTREE));
    return made;
  };

  it('asks for a target when listings point anywhere in the subtree', async () => {
    const { service, prisma } = withSubtree();
    prisma.product.count.mockResolvedValue(3);
    expect(await conflictCode(service.remove('old-pads'))).toBe(
      CategoryDeleteConflict.NEEDS_TARGET,
    );
    expect(prisma.product.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { categoryId: { in: ['old-pads', 'front', 'rear', 'front-left'] } },
          {
            vehicleCategoryId: {
              in: ['old-pads', 'front', 'rear', 'front-left'],
            },
          },
        ],
      },
    });
    expect(prisma.partCategory.deleteMany).not.toHaveBeenCalled();
  });

  it('live drafts need a target too, and only live ones count', async () => {
    const { service, prisma } = makeService();
    prisma.productDraft.count.mockResolvedValue(1);
    expect(await conflictCode(service.remove('old-pads'))).toBe(
      CategoryDeleteConflict.NEEDS_TARGET,
    );
    expect(prisma.productDraft.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: { in: ['CREATING', 'READY_FOR_PREVIEW', 'COMMITTING'] },
      }),
    });
  });

  it('asks for a reassign target with the parts code when parts are the one thing in the way', async () => {
    const { service, prisma } = makeService();
    prisma.catalogPart.count.mockResolvedValue(2);
    expect(await conflictCode(service.remove('old-pads'))).toBe(
      CategoryDeleteConflict.HAS_PARTS,
    );
  });

  it('refuses while a live sale targets anything in the subtree, naming the sale', async () => {
    const { service, prisma } = withSubtree();
    prisma.sale.findMany.mockResolvedValue([{ title: 'Spring brakes' }]);
    await expect(service.remove('old-pads')).rejects.toThrow(/Spring brakes/);
    expect(prisma.sale.findMany.mock.calls[0][0].where.targets).toEqual({
      some: {
        targetType: 'CATEGORIES',
        targetId: { in: ['old-pads', 'front', 'rear', 'front-left'] },
      },
    });
    expect(prisma.partCategory.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    'brakes',
    'motor-oil',
    'other',
    'antifreeze',
    'maintenance-and-fluids',
  ])('refuses "%s": the application depends on it by id', async (id) => {
    const { service, prisma } = makeService();
    expect(await conflictCode(service.remove(id))).toBe(
      CategoryDeleteConflict.PROTECTED,
    );
    expect(prisma.partCategory.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a subtree that holds a protected category, naming it', async () => {
    const { service, prisma } = makeService();
    const edges = [
      { id: 'custom-fluids', parentId: null },
      { id: 'motor-oil', parentId: 'custom-fluids' },
    ];
    prisma.partCategory.findMany.mockResolvedValue(edges);
    prisma.$queryRaw.mockResolvedValue(lockedRows(edges));

    const run = service.remove('custom-fluids');
    expect(await conflictCode(run)).toBe(CategoryDeleteConflict.PROTECTED);
    await expect(service.remove('custom-fluids')).rejects.toThrow(/motor-oil/);
    expect(prisma.partCategory.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses the Uncategorized fallback bucket', async () => {
    const { service } = makeService();
    await expect(service.remove('cat_uncategorized')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('takes the tree lock and the row locks before checking anything', async () => {
    const { service, prisma } = makeService();
    const order: string[] = [];
    prisma.$executeRaw.mockImplementation(() => {
      order.push('tree-lock');
      return Promise.resolve(0);
    });
    prisma.$queryRaw.mockImplementation(() => {
      order.push('row-lock');
      return Promise.resolve([{ id: 'old-pads', parent_id: null, name: 'x' }]);
    });
    prisma.product.count.mockImplementation(() => {
      order.push('checks');
      return Promise.resolve(0);
    });

    await service.remove('old-pads');

    expect(order).toEqual(['tree-lock', 'row-lock', 'checks']);
  });

  it('answers a delete that lost the race with 404', async () => {
    const { service, prisma } = makeService();
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.remove('old-pads')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses when subcategories appeared that the delete did not see', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.count.mockResolvedValue(1);
    expect(await conflictCode(service.remove('old-pads'))).toBe(
      CategoryDeleteConflict.TREE_CHANGED,
    );
    expect(prisma.partCategory.count).toHaveBeenCalledWith({
      where: { parentId: { in: ['old-pads'] }, id: { notIn: ['old-pads'] } },
    });
    expect(prisma.partCategory.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced leaf and busts the cache, its own key included', async () => {
    const { service, prisma, categories } = makeService();
    const res = await service.remove('old-pads');
    expect(prisma.partCategory.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-pads'] } },
    });
    expect(categories.invalidate).toHaveBeenCalledWith(
      'brake-system',
      'old-pads',
    );
    expect(res).toEqual({
      success: true,
      data: {
        deleted: 'old-pads',
        reassigned: 0,
        listings: 0,
        drafts: 0,
        subcategories: [],
      },
    });
  });

  it('deletes an empty subtree, children before their parents', async () => {
    const { service, prisma, categories } = withSubtree();

    const res = await service.remove('old-pads');

    expect(
      prisma.partCategory.deleteMany.mock.calls.map((c) => c[0].where.id.in),
    ).toEqual([['front-left'], ['front', 'rear'], ['old-pads']]);
    expect(categories.invalidate).toHaveBeenCalledWith(
      'brake-system',
      'old-pads',
      'front',
      'rear',
      'front-left',
    );
    expect(res.data.subcategories).toEqual(['front', 'rear', 'front-left']);
  });

  it('records who deleted what, one entry per row, in the same transaction', async () => {
    const { service, prisma, audit } = withSubtree();

    await service.remove('old-pads', undefined, {
      actor: { id: 'adm_1', email: 'a@m.uz', name: 'A' },
    });

    expect(audit.recordMany).toHaveBeenCalledTimes(1);
    const [entries, tx] = audit.recordMany.mock.calls[0];
    expect(tx).toBe(prisma);
    expect(entries.map((e: { target: { id: string } }) => e.target.id)).toEqual(
      ['old-pads', 'front', 'rear', 'front-left'],
    );
    expect(entries[0]).toMatchObject({
      action: 'CATEGORY_DELETED',
      actor: { id: 'adm_1' },
      target: { entity: 'CATEGORY', id: 'old-pads', name: 'old-pads' },
      previousValues: { parentId: 'brake-system', subcategories: 3 },
    });
    expect(entries[3].previousValues).toEqual({
      parentId: 'front',
      deletedWith: 'old-pads',
    });
  });

  describe('with a target', () => {
    const TARGET = { id: 'pads', parentId: 'brakes' };

    const stocked = () => {
      const made = withSubtree();
      const { prisma } = made;
      prisma.partCategory.findUnique.mockResolvedValue(TARGET);
      prisma.catalogPart.count.mockResolvedValue(2);
      prisma.catalogPart.findMany.mockResolvedValue([
        { id: 'p1', kind: 'SPARE_PART', oilType: null, categoryId: 'front' },
        { id: 'p2', kind: 'SPARE_PART', oilType: null, categoryId: 'rear' },
      ]);
      prisma.catalogPart.updateMany.mockResolvedValue({ count: 2 });
      // Three listings before the move, none after it.
      prisma.product.count.mockResolvedValueOnce(3).mockResolvedValue(0);
      made.transfers.drainForDelete.mockImplementation(
        (_tx: unknown, nodeId: string) =>
          Promise.resolve(
            nodeId === 'front-left'
              ? { parts: 0, listings: 3, listingRootCorrections: 0, drafts: 1 }
              : null,
          ),
      );
      return made;
    };

    it('moves the parts, drains every node deepest first, then deletes', async () => {
      const { service, prisma, transfers, categories } = stocked();

      const res = await service.remove('old-pads', 'pads');

      expect(prisma.catalogPart.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            categoryId: { in: ['old-pads', 'front', 'rear', 'front-left'] },
          },
        }),
      );
      expect(prisma.catalogPart.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['p1', 'p2'] } },
        data: expect.objectContaining({ categoryId: 'pads' }),
      });
      expect(transfers.drainForDelete.mock.calls.map((c) => c[1])).toEqual([
        'front-left',
        'rear',
        'front',
        'old-pads',
      ]);
      expect(transfers.drainForDelete.mock.calls[0][2]).toBe('pads');
      expect(prisma.partCategory.deleteMany).toHaveBeenCalledTimes(3);
      expect(res.data).toEqual({
        deleted: 'old-pads',
        reassigned: 2,
        listings: 3,
        drafts: 1,
        subcategories: ['front', 'rear', 'front-left'],
      });
      expect(categories.invalidate).toHaveBeenCalledWith(
        'brake-system',
        'old-pads',
        'front',
        'rear',
        'front-left',
        'pads',
        'brakes',
      );
    });

    it('drains no listings when only parts are there', async () => {
      const { service, prisma, transfers } = stocked();
      prisma.product.count.mockReset().mockResolvedValue(0);

      await service.remove('old-pads', 'pads');

      expect(transfers.drainForDelete).not.toHaveBeenCalled();
      expect(prisma.partCategory.deleteMany).toHaveBeenCalledTimes(3);
    });

    it('refuses a target inside the subtree being deleted', async () => {
      const { service, prisma } = stocked();
      await expect(service.remove('old-pads', 'front')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.catalogPart.updateMany).not.toHaveBeenCalled();
    });

    it('404s on an unknown target, moving nothing', async () => {
      const { service, prisma } = stocked();
      prisma.partCategory.findUnique.mockResolvedValue(null);
      await expect(service.remove('old-pads', 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.catalogPart.updateMany).not.toHaveBeenCalled();
    });

    it("a transfer blocker refuses the whole delete with the transfer's code", async () => {
      const { service, prisma, transfers } = stocked();
      transfers.drainForDelete.mockRejectedValue(
        new ConflictException({ code: 'KIND_MISMATCH', message: 'no' }),
      );
      expect(await conflictCode(service.remove('old-pads', 'pads'))).toBe(
        'KIND_MISMATCH',
      );
      expect(prisma.partCategory.deleteMany).not.toHaveBeenCalled();
    });

    it('listings a transfer could not place refuse the delete rather than lose their category', async () => {
      const { service, prisma } = stocked();
      prisma.product.count.mockReset().mockResolvedValue(1);
      expect(await conflictCode(service.remove('old-pads', 'pads'))).toBe(
        CategoryDeleteConflict.HAS_LISTINGS,
      );
      expect(prisma.partCategory.deleteMany).not.toHaveBeenCalled();
    });
  });
});

// ── Фискальные данные ────────────────────────────────────────────────────────
// A category owns the MXIK and the two Tasnif package codes every product in it
// is fiscalized with. The rule the console must enforce is a property of the ROW
// AFTER the patch, not of the body: "configured" means an MXIK and AT LEAST ONE
// package code — single, set or box, whichever the category is sold as.

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

  it('creates a category with a consumer box code', async () => {
    const { service, prisma } = makeService();
    await service.create({
      nameRu: 'Steering',
      nameUz: 'Steering',
      nameEn: 'Steering',
      name: 'Steering',
      mxik: '08708001133000000',
      packageCodeSingle: '1417728',
      packageCodeSet: '1417729',
      packageCodeBox: '1533557',
    });
    expect(prisma.partCategory.create.mock.calls[0][0].data).toMatchObject({
      packageCodeSingle: '1417728',
      packageCodeSet: '1417729',
      packageCodeBox: '1533557',
    });
  });

  it('rejects a box code with no MXIK', async () => {
    const { service } = makeService();
    await expect(
      service.create({
        nameRu: 'Steering',
        nameUz: 'Steering',
        nameEn: 'Steering',
        name: 'Steering',
        packageCodeBox: '1533557',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('adds a box code to an already-configured category', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(node(FISCAL));

    await service.update('brakes', { packageCodeBox: '1544415' });

    const { data } = prisma.partCategory.update.mock.calls[0][0];
    expect(data.packageCodeBox).toBe('1544415');
  });

  it('shows the box code to the console', () => {
    const row = node({
      ...FISCAL,
      packageCodeBox: '1544415',
    });
    expect(presentAdminCategoryNode(row as never)).toMatchObject({
      packageCodeBox: '1544415',
      offersPackageChoice: true,
    });
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

  it('rejects an MXIK with no package code of any form', async () => {
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

  it('creates a category with only a SET code, no single code', async () => {
    const { service, prisma } = makeService();
    await service.create({
      nameRu: 'Brakes',
      nameUz: 'Brakes',
      nameEn: 'Brakes',
      name: 'Brakes',
      mxik: '08708005011000000',
      packageCodeSet: '1417723',
    });
    const data = prisma.partCategory.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      mxik: '08708005011000000',
      packageCodeSet: '1417723',
    });
    expect(data).not.toHaveProperty('packageCodeSingle');
  });

  it('creates a category with only a BOX code, no single code', async () => {
    const { service, prisma } = makeService();
    await service.create({
      nameRu: 'Steering',
      nameUz: 'Steering',
      nameEn: 'Steering',
      name: 'Steering',
      mxik: '08708001133000000',
      packageCodeBox: '1533557',
    });
    expect(prisma.partCategory.create.mock.calls[0][0].data).toMatchObject({
      mxik: '08708001133000000',
      packageCodeBox: '1533557',
    });
  });

  it('reports a set-only category as ready, with nothing to ask the seller', () => {
    const row = node({
      mxik: FISCAL.mxik,
      packageCodeSingle: null,
      packageCodeSet: FISCAL.packageCodeSet,
    });
    expect(presentAdminCategoryNode(row as never)).toMatchObject({
      fiscalConfigured: true,
      fiscalStatus: 'READY',
      fiscalGaps: [],
      offersPackageChoice: false,
    });
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

  it('lets the single code go while the set code stays', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(node(FISCAL));
    await service.update('brakes', { packageCodeSingle: null });
    const data = prisma.partCategory.update.mock.calls[0][0].data;
    expect(data.packageCodeSingle).toBeNull();
    expect(data).not.toHaveProperty('packageCodeSet');
  });

  it('refuses to strip the LAST package code from a configured category', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(node(FISCAL));
    await expect(
      service.update('brakes', {
        packageCodeSingle: null,
        packageCodeSet: null,
      }),
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
    // Entering the codes is all a category needs for checkout to accept it.
    expect(data).toMatchObject({
      mxik: FISCAL.mxik,
      packageCodeSingle: FISCAL.packageCodeSingle,
      packageCodeSet: FISCAL.packageCodeSet,
      fiscalConfigured: true,
      fiscalStatus: 'READY',
      fiscalGaps: [],
      offersPackageChoice: true,
    });

    prisma.partCategory.findUnique.mockResolvedValue(node());
    const unconfigured = await service.findOne('brakes');
    expect(unconfigured.data).toMatchObject({
      fiscalConfigured: false,
      fiscalStatus: 'NEEDS_CODES',
      offersPackageChoice: false,
    });
  });

  it('reports a parent as not sellable, whatever code it holds', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(
      node({ ...FISCAL, _count: { ...node()._count, children: 2 } }),
    );
    const { data } = await service.findOne('transmission');
    expect(data).toMatchObject({
      mxik: FISCAL.mxik,
      fiscalStatus: 'NOT_SELLABLE',
    });
  });

  it('filters the list by what still needs doing', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findMany.mockResolvedValue([
      node({ id: 'a' }),
      node({ id: 'b', ...FISCAL }),
    ]);

    const ready = await service.list({ fiscalStatus: 'READY' });
    const toFill = await service.list({ fiscalStatus: 'NEEDS_CODES' });

    expect(ready.data.map((n) => n.id)).toEqual(['b']);
    expect(ready.meta.total).toBe(1);
    expect(toFill.data.map((n) => n.id)).toEqual(['a']);
  });

  // ── entering the codes is the whole job ─────────────────────────────────────
  it('codes saved through PATCH /:id make the category ready, with nothing further', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(node());
    prisma.partCategory.update.mockResolvedValue(node(FISCAL));

    const { data } = await service.update('brakes', FISCAL);

    expect(prisma.partCategory.update.mock.calls[0][0].data).toEqual(FISCAL);
    expect(data).toMatchObject({
      ...FISCAL,
      fiscalConfigured: true,
      fiscalStatus: 'READY',
    });
  });

  it.each(Object.entries(REPRESENTATIVE_ONLY_MXIK))(
    '%s stays not sellable while it holds its one-product code',
    async (id, mxik) => {
      const { service, prisma } = makeService();
      prisma.partCategory.findUnique.mockResolvedValue(
        node({ id, mxik, packageCodeSingle: '1350563' }),
      );
      expect((await service.findOne(id)).data).toMatchObject({
        fiscalConfigured: false,
        fiscalStatus: 'NOT_SELLABLE',
      });
    },
  );

  // The console's flag and the receipt must give one answer: reporting a category
  // ready that checkout then refuses is exactly what this rule exists to prevent.
  describe('the console and the receipt agree', () => {
    const TRANSMISSION = {
      mxik: '02710005005000000',
      packageCodeSingle: '1282593',
      packageCodeSet: null,
    };

    it.each([
      ['a leaf with codes', node(FISCAL)],
      ['a leaf with no codes', node()],
      [
        'a parent with codes',
        node({
          ...FISCAL,
          _count: { ...node()._count, children: 2 },
        }),
      ],
      [
        'transmission oil',
        node({
          id: 'transmission-oil',
          parentId: 'motor-oil',
          ...TRANSMISSION,
        }),
      ],
      [
        'a composition',
        node({ id: 'synthetic-motor-oil', parentId: 'motor-oil' }),
      ],
      ['the oil parent', node({ id: 'motor-oil', parentId: null })],
      ['a "Другое" child', node({ id: 'industrial-oil', parentId: 'other' })],
      [
        'the fallback bucket',
        node({ id: 'cat_uncategorized', parentId: null }),
      ],
    ])('%s', (_, row) => {
      const console = presentAdminCategoryNode(row as never);
      const receipt = buildFiscalItem({
        reference: 'item',
        title: 'x',
        quantity: 1,
        priceUzs: 1,
        packageForm: PackageForm.SINGLE,
        category: row as never,
        ...listingTypeForCategory(row.id),
        dealer: { tin: '301234567', vatPercent: 0 },
      });
      expect(console.fiscalConfigured).toBe(receipt.ok);
    });
  });
});
