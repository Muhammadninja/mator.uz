// Tests for the admin Category-tree console: filtered listing, create/update
// with DERIVED levels, activate/deactivate, the delete guards that protect
// referenced categories, and the cache invalidation that makes an admin edit
// reach the Telegram seller bot.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, AdminAuditEntity, PackageForm } from '@prisma/client';
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
      count: jest.fn().mockResolvedValue(0),
    },
    product: { count: jest.fn().mockResolvedValue(0) },
    productDraft: { count: jest.fn().mockResolvedValue(0) },
    sale: { findMany: jest.fn().mockResolvedValue([]) },
    catalogPart: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn(),
    },
    // The row-lock read in remove(): the row exists, under 'brake-system'.
    $queryRaw: jest.fn().mockResolvedValue([{ parent_id: 'brake-system' }]),
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
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminCategoriesService(
    prisma as never,
    categories as never,
    audit as never,
  );
  return { service, prisma, categories, audit };
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

describe('DELETE guards (deactivation is the preferred path)', () => {
  /** The 409's machine code, which is what the console branches on. */
  const conflictCode = async (run: Promise<unknown>) => {
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    return ((err as ConflictException).getResponse() as { code?: string }).code;
  };

  it('refuses to delete a category referenced by listings', async () => {
    const { service, prisma } = makeService();
    prisma.product.count.mockResolvedValue(3);
    expect(await conflictCode(service.remove('old-pads'))).toBe(
      CategoryDeleteConflict.HAS_LISTINGS,
    );
    expect(prisma.partCategory.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete a category referenced by live drafts, and counts only those', async () => {
    const { service, prisma } = makeService();
    prisma.productDraft.count.mockResolvedValue(1);
    expect(await conflictCode(service.remove('old-pads'))).toBe(
      CategoryDeleteConflict.HAS_LISTINGS,
    );
    expect(prisma.productDraft.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: { in: ['CREATING', 'READY_FOR_PREVIEW', 'COMMITTING'] },
      }),
    });
  });

  it('refuses while a live sale targets it, naming the sale', async () => {
    const { service, prisma } = makeService();
    prisma.sale.findMany.mockResolvedValue([{ title: 'Spring brakes' }]);
    const run = service.remove('old-pads');
    await expect(run).rejects.toThrow(/Spring brakes/);
    expect(prisma.partCategory.delete).not.toHaveBeenCalled();
  });

  it('records who deleted what, in the same transaction', async () => {
    const { service, prisma, audit } = makeService();
    prisma.$queryRaw.mockResolvedValue([{ parent_id: null, name: 'Old pads' }]);

    await service.remove('old-pads', undefined, {
      actor: { id: 'adm_1', email: 'a@m.uz', name: 'A' },
    });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: 'CATEGORY_DELETED',
      actor: { id: 'adm_1' },
      target: { entity: 'CATEGORY', id: 'old-pads', name: 'Old pads' },
    });
  });

  it('asks for a reassign target only when parts are the one thing in the way', async () => {
    const { service, prisma } = makeService();
    prisma.catalogPart.count.mockResolvedValue(2);
    expect(await conflictCode(service.remove('old-pads'))).toBe(
      CategoryDeleteConflict.HAS_PARTS,
    );
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
    expect(prisma.partCategory.delete).not.toHaveBeenCalled();
  });

  it('takes the tree lock and the row lock before checking anything', async () => {
    const { service, prisma } = makeService();
    const order: string[] = [];
    prisma.$executeRaw.mockImplementation(() => {
      order.push('tree-lock');
      return Promise.resolve(0);
    });
    prisma.$queryRaw.mockImplementation(() => {
      order.push('row-lock');
      return Promise.resolve([{ parent_id: null }]);
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

  it('deletes an unreferenced leaf and busts the cache, its own key included', async () => {
    const { service, prisma, categories } = makeService();
    const res = await service.remove('old-pads');
    expect(prisma.partCategory.delete).toHaveBeenCalledWith({
      where: { id: 'old-pads' },
    });
    expect(categories.invalidate).toHaveBeenCalledWith(
      'brake-system',
      'old-pads',
    );
    expect(res).toEqual({
      success: true,
      data: { deleted: 'old-pads', reassigned: 0 },
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
  /** What an operator confirms for FISCAL: the exact codes, as one string. */
  const CODES = '08708005011000000:1417722:1417723';

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

  it('rejects a box code with no MXIK or single code', async () => {
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

  it('adds a box code to an already-configured category, which ends its confirmation', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(
      node({ ...FISCAL, fiscalConfirmedCodes: CODES }),
    );

    await service.update('brakes', { packageCodeBox: '1544415' });

    const { data } = prisma.partCategory.update.mock.calls[0][0];
    expect(data.packageCodeBox).toBe('1544415');
    expect(data.fiscalConfirmedCodes).toBeNull();
  });

  it('shows the box code to the console, and what confirming it would cover', () => {
    const row = node({
      ...FISCAL,
      packageCodeBox: '1544415',
    });
    expect(presentAdminCategoryNode(row as never)).toMatchObject({
      packageCodeBox: '1544415',
      fiscalCodesToConfirm: `${CODES}:1544415`,
      offersPackageChoice: true,
    });
  });

  it('keeps the string an existing confirmation was given under, while there is no box', () => {
    expect(
      presentAdminCategoryNode(
        node({ ...FISCAL, fiscalConfirmedCodes: CODES }) as never,
      ),
    ).toMatchObject({ fiscalCodesToConfirm: CODES, fiscalStatus: 'READY' });
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
    // A code nobody confirmed is not yet a category checkout will accept.
    expect(data).toMatchObject({
      mxik: FISCAL.mxik,
      packageCodeSingle: FISCAL.packageCodeSingle,
      packageCodeSet: FISCAL.packageCodeSet,
      fiscalConfigured: false,
      fiscalStatus: 'NEEDS_CONFIRMATION',
      fiscalCodesToConfirm: CODES,
      offersPackageChoice: true,
    });

    prisma.partCategory.findUnique.mockResolvedValue(
      node({ ...FISCAL, fiscalConfirmedCodes: CODES }),
    );
    const confirmed = await service.findOne('brakes');
    expect(confirmed.data).toMatchObject({
      fiscalConfigured: true,
      fiscalStatus: 'READY',
      fiscalGaps: [],
    });

    prisma.partCategory.findUnique.mockResolvedValue(node());
    const unconfigured = await service.findOne('brakes');
    expect(unconfigured.data).toMatchObject({
      fiscalConfigured: false,
      fiscalStatus: 'NEEDS_CODES',
      fiscalCodesToConfirm: null,
      offersPackageChoice: false,
    });
  });

  it('offers nothing to confirm on a parent, which a confirmation would refuse', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findUnique.mockResolvedValue(
      node({ ...FISCAL, _count: { ...node()._count, children: 2 } }),
    );
    const { data } = await service.findOne('transmission');
    expect(data).toMatchObject({
      mxik: FISCAL.mxik,
      fiscalStatus: 'NOT_SELLABLE',
      fiscalCodesToConfirm: null,
    });
  });

  it('filters the list by what still needs doing', async () => {
    const { service, prisma } = makeService();
    prisma.partCategory.findMany.mockResolvedValue([
      node({ id: 'a' }),
      node({ id: 'b', ...FISCAL }),
      node({ id: 'c', ...FISCAL, fiscalConfirmedCodes: CODES }),
    ]);

    const toConfirm = await service.list({
      fiscalStatus: 'NEEDS_CONFIRMATION',
    });
    const toFill = await service.list({ fiscalStatus: 'NEEDS_CODES' });

    expect(toConfirm.data.map((n) => n.id)).toEqual(['b']);
    expect(toConfirm.meta.total).toBe(1);
    expect(toFill.data.map((n) => n.id)).toEqual(['a']);
  });

  // ── the confirmation ───────────────────────────────────────────────────────
  describe('PATCH /:id/fiscal-confirmation', () => {
    const ctx = { actor: { id: 'adm_1', email: 'a@b.c', name: 'A' } };
    const childCounts = (children: number) => ({
      parts: 0,
      products: 0,
      productsVehicle: 0,
      drafts: 0,
      draftsVehicle: 0,
      children,
    });

    it('stores the exact codes that were checked, and audits who confirmed them', async () => {
      const { service, prisma, audit } = makeService();
      prisma.partCategory.findUnique.mockResolvedValue(node(FISCAL));

      await service.setFiscalConfirmation(
        'brakes',
        { confirmed: true, codes: CODES },
        ctx,
      );

      expect(prisma.partCategory.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'brakes' },
        data: { fiscalConfirmedCodes: CODES },
      });
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AdminAuditAction.CATEGORY_FISCAL_CONFIRMED,
        target: { entity: AdminAuditEntity.CATEGORY, id: 'brakes' },
        newValues: { fiscalConfirmedCodes: CODES },
      });
    });

    it('confirms a composition’s codes from the oil table: its columns are empty', async () => {
      const { service, prisma } = makeService();
      prisma.partCategory.findUnique.mockResolvedValue(
        node({ id: 'synthetic-motor-oil', parentId: 'motor-oil' }),
      );
      const codes = '02710005001000000:1282037:';

      await service.setFiscalConfirmation('synthetic-motor-oil', {
        confirmed: true,
        codes,
      });

      expect(
        prisma.partCategory.update.mock.calls[0][0].data.fiscalConfirmedCodes,
      ).toBe(codes);
    });

    const refused = async (row: unknown, dto: never) => {
      const { service, prisma, audit } = makeService();
      prisma.partCategory.findUnique.mockResolvedValue(row);
      const error = await service
        .setFiscalConfirmation('brakes', dto)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(prisma.partCategory.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      return (error as ConflictException).getResponse();
    };

    it('refuses codes that changed since they were checked', async () => {
      await expect(
        refused(node(FISCAL), {
          confirmed: true,
          codes: '08708005011000000:1417722:',
        } as never),
      ).resolves.toMatchObject({ code: 'FISCAL_CODES_CHANGED' });
    });

    it('refuses a category with nothing to confirm', async () => {
      await expect(
        refused(node(), { confirmed: true, codes: CODES } as never),
      ).resolves.toMatchObject({ code: 'FISCAL_CODES_MISSING' });
    });

    it('refuses a parent: its code would not describe what is under it', async () => {
      await expect(
        refused(node({ ...FISCAL, _count: childCounts(3) }), {
          confirmed: true,
          codes: CODES,
        } as never),
      ).resolves.toMatchObject({ code: 'CATEGORY_NOT_SELLABLE' });
    });

    it('withdrawing needs no codes and is audited', async () => {
      const { service, prisma, audit } = makeService();
      prisma.partCategory.findUnique.mockResolvedValue(
        node({ ...FISCAL, fiscalConfirmedCodes: CODES }),
      );

      await service.setFiscalConfirmation('brakes', { confirmed: false }, ctx);

      expect(
        prisma.partCategory.update.mock.calls[0][0].data.fiscalConfirmedCodes,
      ).toBeNull();
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AdminAuditAction.CATEGORY_FISCAL_UNCONFIRMED,
        previousValues: { fiscalConfirmedCodes: CODES },
      });
    });

    it.each([
      ['the MXIK', { mxik: '08708005011999999' }],
      ['the single package code', { packageCodeSingle: '1417799' }],
      ['the set package code', { packageCodeSet: '1417799' }],
      ['the set package code, by removing it', { packageCodeSet: null }],
      ['the box package code', { packageCodeBox: '1417799' }],
    ])('changing %s ends the confirmation for good', async (_, change) => {
      const { service, prisma } = makeService();
      prisma.partCategory.findUnique.mockResolvedValue(
        node({ ...FISCAL, fiscalConfirmedCodes: CODES }),
      );

      await service.update('brakes', change);

      const { data } = prisma.partCategory.update.mock.calls[0][0];
      expect(data).toMatchObject({ ...change, fiscalConfirmedCodes: null });
    });

    it('a PATCH that changes no code leaves a confirmation alone', async () => {
      const { service, prisma } = makeService();
      prisma.partCategory.findUnique.mockResolvedValue(
        node({ ...FISCAL, fiscalConfirmedCodes: CODES }),
      );

      await service.update('brakes', { name: 'Тормоза' });
      await service.update('brakes', { mxik: FISCAL.mxik });

      for (const [{ data }] of prisma.partCategory.update.mock.calls) {
        expect(data).not.toHaveProperty('fiscalConfirmedCodes');
      }
    });

    it('a code changed by any other route no longer counts as confirmed', async () => {
      const { service, prisma } = makeService();
      prisma.partCategory.findUnique.mockResolvedValue(
        node({
          ...FISCAL,
          mxik: '08708005011999999',
          fiscalConfirmedCodes: CODES,
        }),
      );
      expect((await service.findOne('brakes')).data.fiscalStatus).toBe(
        'NEEDS_CONFIRMATION',
      );
    });

    it.each(Object.entries(REPRESENTATIVE_ONLY_MXIK))(
      '%s cannot be confirmed while it holds its one-product code',
      async (id, mxik) => {
        const { service, prisma } = makeService();
        prisma.partCategory.findUnique.mockResolvedValue(
          node({ id, mxik, packageCodeSingle: '1350563' }),
        );

        await expect(
          service.setFiscalConfirmation(id, {
            confirmed: true,
            codes: `${mxik}:1350563:`,
          }),
        ).rejects.toMatchObject({
          response: { code: 'CATEGORY_NOT_SELLABLE' },
        });
        expect(prisma.partCategory.update).not.toHaveBeenCalled();
      },
    );

    it('a different code on one of those is an ordinary confirmation', async () => {
      const { service, prisma } = makeService();
      const row = node({
        id: 'lighting',
        mxik: '08512001999000000',
        packageCodeSingle: '1350743',
      });
      prisma.partCategory.findUnique.mockResolvedValue(row);
      prisma.partCategory.update.mockResolvedValue(row);

      await service.setFiscalConfirmation('lighting', {
        confirmed: true,
        codes: '08512001999000000:1350743:',
      });

      expect(prisma.partCategory.update.mock.calls[0][0].data).toEqual({
        fiscalConfirmedCodes: '08512001999000000:1350743:',
      });
    });
  });

  // The console's flag and the receipt must give one answer: reporting a category
  // ready that checkout then refuses is exactly what this rule exists to prevent.
  describe('the console and the receipt agree', () => {
    const TRANSMISSION = {
      mxik: '02710005005000000',
      packageCodeSingle: '1282593',
      packageCodeSet: null,
    };
    const TRANSMISSION_CODES = '02710005005000000:1282593:';

    it.each([
      ['a confirmed leaf', node({ ...FISCAL, fiscalConfirmedCodes: CODES })],
      ['an unconfirmed leaf', node(FISCAL)],
      ['a leaf with no codes', node()],
      [
        'a confirmation of other codes',
        node({ ...FISCAL, fiscalConfirmedCodes: 'other:codes:' }),
      ],
      [
        'a confirmed parent',
        node({
          ...FISCAL,
          fiscalConfirmedCodes: CODES,
          _count: { ...node()._count, children: 2 },
        }),
      ],
      [
        'transmission oil, confirmed',
        node({
          id: 'transmission-oil',
          parentId: 'motor-oil',
          ...TRANSMISSION,
          fiscalConfirmedCodes: TRANSMISSION_CODES,
        }),
      ],
      [
        'transmission oil, unconfirmed',
        node({
          id: 'transmission-oil',
          parentId: 'motor-oil',
          ...TRANSMISSION,
        }),
      ],
      [
        'a composition, confirmed',
        node({
          id: 'synthetic-motor-oil',
          parentId: 'motor-oil',
          fiscalConfirmedCodes: '02710005001000000:1282037:',
        }),
      ],
      [
        'a composition, unconfirmed',
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
