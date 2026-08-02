// Unit tests for the sales CRUD service. Prisma is mocked — no DB. These guard:
// the validation rules (discount > 0, percent <= 100, endAt >= startAt) INCLUDING
// the merged-state re-check that stops a PATCH splitting a violation across two
// requests, the scope/targetIds pairing, target-existence checking per scope,
// the derived lifecycle filter, pagination meta, the public endpoint returning
// only active sales through the same predicate as pricing, and the presenter
// shapes. A separate block validates the DTOs reject bad input (400).

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, SaleDiscountType, SaleScopeType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DiscountService } from './discount.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesQueryDto } from './dto/list-sales.query.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { SalesService } from './sales.service';

/**
 * The Prisma call shapes these tests assert against. Typed rather than left as
 * `jest.fn()` (whose args are `any`) so that an assertion on `where`, `data` or
 * `orderBy` is type-checked — a test that reads a field the service never sets
 * fails to compile instead of silently passing on `undefined`.
 */
interface SaleCreateArgs {
  data: {
    id: string;
    scopeType: SaleScopeType;
    isActive: boolean;
    targets: {
      create: { id: string; targetType: SaleScopeType; targetId: string }[];
    };
  };
}
interface SaleFindManyArgs {
  where: Prisma.SaleWhereInput & { AND?: Prisma.SaleWhereInput[] };
  orderBy?: Prisma.SaleOrderByWithRelationInput[];
  skip?: number;
  take?: number;
}
interface SaleUpdateArgs {
  where: { id: string };
  data: Prisma.SaleUpdateInput;
}
interface CountArgs {
  where: { id: { in: string[] } };
}

function makePrismaMock() {
  // The RETURN type is `Promise<unknown>`, not `unknown`: these are async Prisma
  // methods, and `mockResolvedValue` resolves its parameter from the awaited
  // return type. Declaring it as bare `unknown` made that parameter `never`, so
  // every `mockResolvedValue(row)` failed to compile. The ARGUMENT tuples — the
  // part that actually buys type-safety on `where`/`data`/`orderBy` — are
  // unchanged.
  const sale = {
    findMany: jest.fn<Promise<unknown>, [SaleFindManyArgs]>(),
    // getOne/update read through findFirst (they filter on deletedAt too);
    // remove reads through findUnique by primary key.
    findFirst: jest.fn<Promise<unknown>, [{ where: Prisma.SaleWhereInput }]>(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    count: jest.fn(),
    create: jest.fn<Promise<unknown>, [SaleCreateArgs]>(),
    update: jest.fn<Promise<unknown>, [SaleUpdateArgs]>(),
    delete: jest.fn(),
  };
  const saleTarget = { deleteMany: jest.fn(), createMany: jest.fn() };
  const catalogPart = { count: jest.fn<Promise<number>, [CountArgs]>() };
  const partCategory = { count: jest.fn<Promise<number>, [CountArgs]>() };
  const catalogSeller = { count: jest.fn<Promise<number>, [CountArgs]>() };

  const prisma: Record<string, unknown> = {
    sale,
    saleTarget,
    catalogPart,
    partCategory,
    catalogSeller,
  };
  // Array form runs the (already-invoked) query promises; callback form gets the
  // mock itself, so the service's `tx` IS this same mock.
  prisma.$transaction = (arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(prisma);

  return prisma as typeof prisma & {
    sale: typeof sale;
    saleTarget: typeof saleTarget;
    catalogPart: typeof catalogPart;
    partCategory: typeof partCategory;
    catalogSeller: typeof catalogSeller;
  };
}

/** A persisted sale row as the presenter consumes it. */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sale_1',
    title: 'Test sale',
    description: null,
    discountType: SaleDiscountType.PERCENT,
    discountValue: new Prisma.Decimal(10),
    scopeType: SaleScopeType.ALL_PRODUCTS,
    startAt: new Date('2026-01-01T00:00:00Z'),
    endAt: null,
    isActive: true,
    priority: 0,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    _count: { targets: 0 },
    targets: [],
    ...overrides,
  };
}

const VALID_CREATE: CreateSaleDto = {
  title: 'Summer sale',
  discountType: SaleDiscountType.PERCENT,
  discountValue: 15,
  startAt: '2026-07-01T00:00:00.000Z',
};

describe('SalesService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: SalesService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new SalesService(
      prisma as never,
      new DiscountService(prisma as never),
    );
  });

  describe('create', () => {
    it('persists an ALL_PRODUCTS sale with a prefixed id and no targets', async () => {
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeRow());

      const result = await service.create(VALID_CREATE);

      const args = prisma.sale.create.mock.calls[0][0];
      expect(args.data.id).toMatch(/^sale_/);
      expect(args.data.scopeType).toBe(SaleScopeType.ALL_PRODUCTS);
      expect(args.data.targets.create).toEqual([]);
      expect(args.data.isActive).toBe(true);
      expect(result.success).toBe(true);
    });

    it('persists a scoped sale with one target row per id', async () => {
      prisma.catalogPart.count.mockResolvedValue(2);
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeRow());

      await service.create({
        ...VALID_CREATE,
        scopeType: SaleScopeType.PRODUCTS,
        targetIds: ['part_1', 'part_2'],
      });

      const targets = prisma.sale.create.mock.calls[0][0].data.targets.create;
      expect(targets).toHaveLength(2);
      expect(targets[0]).toMatchObject({
        targetType: SaleScopeType.PRODUCTS,
        targetId: 'part_1',
      });
      expect(targets[0].id).toMatch(/^stgt_/);
    });

    it.each([
      [SaleScopeType.PRODUCTS, 'catalogPart'],
      [SaleScopeType.CATEGORIES, 'partCategory'],
      [SaleScopeType.DEALERS, 'catalogSeller'],
    ])('checks %s targets against the right table', async (scope, table) => {
      prisma[table as 'catalogPart'].count.mockResolvedValue(1);
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeRow());

      await service.create({
        ...VALID_CREATE,
        scopeType: scope,
        targetIds: ['x_1'],
      });

      expect(prisma[table as 'catalogPart'].count).toHaveBeenCalledWith({
        where: { id: { in: ['x_1'] } },
      });
    });

    it('rejects a target id that does not exist', async () => {
      prisma.catalogPart.count.mockResolvedValue(1); // only 1 of 2 found

      await expect(
        service.create({
          ...VALID_CREATE,
          scopeType: SaleScopeType.PRODUCTS,
          targetIds: ['part_1', 'part_TYPO'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.sale.create).not.toHaveBeenCalled();
    });

    it('rejects a scoped sale with no targetIds', async () => {
      await expect(
        service.create({
          ...VALID_CREATE,
          scopeType: SaleScopeType.CATEGORIES,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects targetIds on an ALL_PRODUCTS sale', async () => {
      await expect(
        service.create({
          ...VALID_CREATE,
          scopeType: SaleScopeType.ALL_PRODUCTS,
          targetIds: ['part_1'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects endAt before startAt', async () => {
      await expect(
        service.create({
          ...VALID_CREATE,
          startAt: '2026-08-01T00:00:00.000Z',
          endAt: '2026-07-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a percent discount above 100', async () => {
      await expect(
        service.create({
          ...VALID_CREATE,
          discountValue: 101,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a fixed discount above 100 (it is UZS, not a percentage)', async () => {
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeRow());

      await expect(
        service.create({
          ...VALID_CREATE,
          discountType: SaleDiscountType.FIXED,
          discountValue: 50_000,
        }),
      ).resolves.toBeDefined();
    });

    it('de-duplicates repeated target ids', async () => {
      prisma.catalogPart.count.mockResolvedValue(1);
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeRow());

      await service.create({
        ...VALID_CREATE,
        scopeType: SaleScopeType.PRODUCTS,
        targetIds: ['part_1', 'part_1'],
      });

      expect(
        prisma.sale.create.mock.calls[0][0].data.targets.create,
      ).toHaveLength(1);
    });
  });

  describe('update', () => {
    const stored = {
      id: 'sale_1',
      discountType: SaleDiscountType.PERCENT,
      discountValue: new Prisma.Decimal(10),
      scopeType: SaleScopeType.ALL_PRODUCTS,
      startAt: new Date('2026-07-01T00:00:00Z'),
      endAt: null,
    };

    it('404s on an unknown sale', async () => {
      prisma.sale.findFirst.mockResolvedValue(null);

      await expect(service.update('nope', { title: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects an empty body', async () => {
      prisma.sale.findFirst.mockResolvedValue(stored);

      await expect(service.update('sale_1', {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('re-checks percent <= 100 against the STORED type when only the value changes', async () => {
      // The DTO cannot catch this: the body has no discountType to compare to.
      prisma.sale.findFirst.mockResolvedValue(stored);

      await expect(
        service.update('sale_1', { discountValue: 150 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('re-checks the window against the STORED startAt when only endAt changes', async () => {
      prisma.sale.findFirst.mockResolvedValue(stored);

      await expect(
        service.update('sale_1', { endAt: '2026-06-01T00:00:00.000Z' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows a value over 100 once the type is switched to FIXED in the same body', async () => {
      prisma.sale.findFirst.mockResolvedValue(stored);
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeRow());

      await expect(
        service.update('sale_1', {
          discountType: SaleDiscountType.FIXED,
          discountValue: 50_000,
        }),
      ).resolves.toBeDefined();
    });

    it('leaves targets alone when neither targetIds nor scopeType is sent', async () => {
      prisma.sale.findFirst.mockResolvedValue(stored);
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeRow());

      await service.update('sale_1', { title: 'Renamed' });

      expect(prisma.saleTarget.deleteMany).not.toHaveBeenCalled();
      expect(prisma.saleTarget.createMany).not.toHaveBeenCalled();
    });

    it('replaces the target set when targetIds is sent', async () => {
      prisma.sale.findFirst.mockResolvedValue({
        ...stored,
        scopeType: SaleScopeType.PRODUCTS,
      });
      prisma.catalogPart.count.mockResolvedValue(1);
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeRow());

      await service.update('sale_1', { targetIds: ['part_9'] });

      expect(prisma.saleTarget.deleteMany).toHaveBeenCalledWith({
        where: { saleId: 'sale_1' },
      });
      expect(prisma.saleTarget.createMany).toHaveBeenCalled();
    });

    it('requires targetIds when the scope changes away from ALL_PRODUCTS', async () => {
      prisma.sale.findFirst.mockResolvedValue(stored);

      await expect(
        service.update('sale_1', { scopeType: SaleScopeType.DEALERS }),
      ).rejects.toThrow(BadRequestException);
    });

    it('only writes the fields the body actually carries', async () => {
      prisma.sale.findFirst.mockResolvedValue(stored);
      prisma.sale.findUniqueOrThrow.mockResolvedValue(makeRow());

      await service.update('sale_1', { isActive: false });

      expect(prisma.sale.update.mock.calls[0][0].data).toEqual({
        isActive: false,
      });
    });
  });

  describe('remove (soft delete)', () => {
    it('404s on an unknown sale', async () => {
      prisma.sale.findUnique.mockResolvedValue(null);

      await expect(service.remove('nope')).rejects.toThrow(NotFoundException);
      expect(prisma.sale.update).not.toHaveBeenCalled();
    });

    it('stamps deletedAt instead of deleting the row', async () => {
      prisma.sale.findUnique.mockResolvedValue({
        id: 'sale_1',
        deletedAt: null,
      });

      const result = await service.remove('sale_1');

      // The row survives — history is not lost.
      expect(prisma.sale.delete).not.toHaveBeenCalled();
      const args = prisma.sale.update.mock.calls[0][0];
      expect(args.where).toEqual({ id: 'sale_1' });
      expect(args.data.deletedAt).toBeInstanceOf(Date);
      // The response contract is unchanged from a hard delete.
      expect(result.data).toEqual({ id: 'sale_1', deleted: true });
    });

    it('404s on an already-deleted sale so the timestamp records the FIRST deletion', async () => {
      prisma.sale.findUnique.mockResolvedValue({
        id: 'sale_1',
        deletedAt: new Date('2026-07-01T00:00:00Z'),
      });

      await expect(service.remove('sale_1')).rejects.toThrow(NotFoundException);
      expect(prisma.sale.update).not.toHaveBeenCalled();
    });
  });

  describe('soft-delete visibility', () => {
    it('hides deleted sales from the admin list by default', async () => {
      prisma.sale.findMany.mockResolvedValue([]);
      prisma.sale.count.mockResolvedValue(0);

      await service.list({});

      expect(prisma.sale.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
    });

    it('surfaces them with includeDeleted=true', async () => {
      prisma.sale.findMany.mockResolvedValue([]);
      prisma.sale.count.mockResolvedValue(0);

      await service.list({ includeDeleted: 'true' });

      expect(
        prisma.sale.findMany.mock.calls[0][0].where.deletedAt,
      ).toBeUndefined();
    });

    it('status=deleted implies includeDeleted rather than contradicting it', async () => {
      prisma.sale.findMany.mockResolvedValue([]);
      prisma.sale.count.mockResolvedValue(0);

      await service.list({ status: 'deleted' });

      const where = prisma.sale.findMany.mock.calls[0][0];
      // Not pinned to null, or the lifecycle predicate below could never match.
      expect(where.where.deletedAt).toBeUndefined();
      expect(where.where.AND?.[0]).toEqual({ deletedAt: { not: null } });
    });

    it.each(['scheduled', 'expired', 'inactive'] as const)(
      'the %s filter excludes deleted sales even when they are included',
      async (status) => {
        prisma.sale.findMany.mockResolvedValue([]);
        prisma.sale.count.mockResolvedValue(0);

        await service.list({ status, includeDeleted: 'true' });

        expect(
          prisma.sale.findMany.mock.calls[0][0].where.AND?.[0],
        ).toMatchObject({ deletedAt: null });
      },
    );

    it('404s getOne on a deleted sale', async () => {
      prisma.sale.findFirst.mockResolvedValue(null);

      await expect(service.getOne('sale_1')).rejects.toThrow(NotFoundException);
      expect(prisma.sale.findFirst.mock.calls[0][0]).toMatchObject({
        where: { id: 'sale_1', deletedAt: null },
      });
    });

    it('404s update on a deleted sale — deletion is terminal', async () => {
      prisma.sale.findFirst.mockResolvedValue(null);

      await expect(
        service.update('sale_1', { isActive: true }),
      ).rejects.toThrow(NotFoundException);
    });

    it('reports a deleted sale as status=deleted, outranking isActive', async () => {
      prisma.sale.count.mockResolvedValue(1);
      prisma.sale.findMany.mockResolvedValue([
        makeRow({
          isActive: true,
          deletedAt: new Date('2026-07-01T00:00:00Z'),
        }),
      ]);

      const result = await service.list({ includeDeleted: 'true' });

      expect(result.data[0].status).toBe('deleted');
      expect(result.data[0].deletedAt).toBe('2026-07-01T00:00:00.000Z');
    });
  });

  describe('list', () => {
    it('returns pagination meta and the presented rows', async () => {
      prisma.sale.findMany.mockResolvedValue([makeRow()]);
      prisma.sale.count.mockResolvedValue(41);

      const result = await service.list({ page: 2, limit: 20 });

      expect(prisma.sale.findMany.mock.calls[0][0]).toMatchObject({
        skip: 20,
        take: 20,
      });
      expect(result.meta).toEqual({
        page: 2,
        limit: 20,
        totalItems: 41,
        totalPages: 3,
      });
      expect(result.data[0]).toMatchObject({
        id: 'sale_1',
        discountValue: 10,
        targetCount: 0,
        startAt: '2026-01-01T00:00:00.000Z',
        endAt: null,
      });
    });

    it('always breaks ties on id so paging cannot repeat or skip a row', async () => {
      prisma.sale.findMany.mockResolvedValue([]);
      prisma.sale.count.mockResolvedValue(0);

      await service.list({});

      expect(prisma.sale.findMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('composes the lifecycle filter under AND so it cannot clobber isActive', async () => {
      prisma.sale.findMany.mockResolvedValue([]);
      prisma.sale.count.mockResolvedValue(0);

      await service.list({ status: 'active', isActive: 'false' });

      const where = prisma.sale.findMany.mock.calls[0][0].where;
      expect(where.isActive).toBe(false);
      expect(where.AND).toHaveLength(1);
      // `AND` is optional on the args interface; the assertion above is what
      // establishes it is present, so the index is safe here.
      expect(where.AND![0].isActive).toBe(true);
    });

    it.each([
      ['scheduled', { isActive: true }],
      ['inactive', { isActive: false }],
    ])(
      'maps the %s lifecycle onto a window predicate',
      async (status, shape) => {
        prisma.sale.findMany.mockResolvedValue([]);
        prisma.sale.count.mockResolvedValue(0);

        await service.list({ status: status as 'scheduled' });

        expect(
          prisma.sale.findMany.mock.calls[0][0].where.AND![0],
        ).toMatchObject(shape);
      },
    );

    it('derives the lifecycle status on each row', async () => {
      prisma.sale.count.mockResolvedValue(1);
      prisma.sale.findMany.mockResolvedValue([makeRow({ isActive: false })]);

      const result = await service.list({});

      expect(result.data[0].status).toBe('inactive');
    });
  });

  describe('getOne', () => {
    it('404s on an unknown sale', async () => {
      prisma.sale.findFirst.mockResolvedValue(null);

      await expect(service.getOne('nope')).rejects.toThrow(NotFoundException);
    });

    it('includes the target ids', async () => {
      prisma.sale.findFirst.mockResolvedValue(
        makeRow({
          scopeType: SaleScopeType.PRODUCTS,
          _count: { targets: 2 },
          targets: [
            { targetType: SaleScopeType.PRODUCTS, targetId: 'part_1' },
            { targetType: SaleScopeType.PRODUCTS, targetId: 'part_2' },
          ],
        }),
      );

      const result = await service.getOne('sale_1');

      expect(result.data.targetIds).toEqual(['part_1', 'part_2']);
    });
  });

  describe('listPublic', () => {
    it('filters through the same activeness predicate the pricing path uses', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await service.listPublic();

      const where = prisma.sale.findMany.mock.calls[0][0].where;
      expect(where.deletedAt).toBeNull();
      expect(where.isActive).toBe(true);
      expect(where.startAt).toEqual({ lte: expect.any(Date) as Date });
      expect(where.OR).toEqual([
        { endAt: null },
        { endAt: { gte: expect.any(Date) as Date } },
      ]);
    });

    it('returns the narrow public shape, without operational fields', async () => {
      prisma.sale.findMany.mockResolvedValue([makeRow({ priority: 7 })]);

      const result = await service.listPublic();

      expect(result.items[0]).toEqual({
        id: 'sale_1',
        title: 'Test sale',
        description: null,
        discountType: SaleDiscountType.PERCENT,
        discountValue: 10,
        scopeType: SaleScopeType.ALL_PRODUCTS,
        targetIds: [],
        startAt: '2026-01-01T00:00:00.000Z',
        endAt: null,
      });
      expect(result.items[0]).not.toHaveProperty('priority');
      expect(result.items[0]).not.toHaveProperty('isActive');
    });
  });
});

describe('Sales DTO validation', () => {
  function errorsFor<T extends object>(cls: new () => T, payload: unknown) {
    return validateSync(plainToInstance(cls, payload) as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  }

  it('accepts a well-formed create body', () => {
    expect(errorsFor(CreateSaleDto, VALID_CREATE)).toHaveLength(0);
  });

  it.each([
    ['a zero discount', { discountValue: 0 }],
    ['a negative discount', { discountValue: -5 }],
    ['a percent discount over 100', { discountValue: 101 }],
    ['more than two decimal places', { discountValue: 10.123 }],
    ['a non-ISO startAt', { startAt: 'yesterday' }],
    ['an unknown discountType', { discountType: 'BOGUS' }],
    ['an unknown scopeType', { scopeType: 'BOGUS' }],
    ['a blank title', { title: '' }],
  ])('rejects %s', (_label, patch) => {
    expect(
      errorsFor(CreateSaleDto, { ...VALID_CREATE, ...patch }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects endAt before startAt', () => {
    const errors = errorsFor(CreateSaleDto, {
      ...VALID_CREATE,
      endAt: '2026-06-01T00:00:00.000Z',
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts endAt equal to startAt', () => {
    expect(
      errorsFor(CreateSaleDto, {
        ...VALID_CREATE,
        endAt: VALID_CREATE.startAt,
      }),
    ).toHaveLength(0);
  });

  it('accepts a fixed discount over 100', () => {
    expect(
      errorsFor(CreateSaleDto, {
        ...VALID_CREATE,
        discountType: SaleDiscountType.FIXED,
        discountValue: 50_000,
      }),
    ).toHaveLength(0);
  });

  it('rejects an unknown field rather than silently ignoring it', () => {
    expect(
      errorsFor(CreateSaleDto, { ...VALID_CREATE, sneaky: true }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects duplicate target ids', () => {
    expect(
      errorsFor(CreateSaleDto, {
        ...VALID_CREATE,
        scopeType: SaleScopeType.PRODUCTS,
        targetIds: ['part_1', 'part_1'],
      }).length,
    ).toBeGreaterThan(0);
  });

  it('allows an empty update body at the DTO level (the service rejects it)', () => {
    expect(errorsFor(UpdateSaleDto, {})).toHaveLength(0);
  });

  it.each([
    ['a bad sort field', { sort: 'DROP TABLE' }],
    ['a bad order', { order: 'sideways' }],
    ['a bad status', { status: 'maybe' }],
    ['a non-boolean isActive', { isActive: 'perhaps' }],
    ['a limit over the ceiling', { limit: 500 }],
  ])('rejects %s on the list query', (_label, patch) => {
    expect(errorsFor(ListSalesQueryDto, patch).length).toBeGreaterThan(0);
  });

  it('accepts a well-formed list query', () => {
    expect(
      errorsFor(ListSalesQueryDto, {
        page: 1,
        limit: 20,
        status: 'active',
        sort: 'startAt',
        order: 'desc',
        isActive: 'true',
      }),
    ).toHaveLength(0);
  });
});
