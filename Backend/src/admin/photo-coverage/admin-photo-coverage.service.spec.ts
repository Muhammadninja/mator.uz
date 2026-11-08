// AdminPhotoCoverageService with Prisma stubbed (no database). Pins the SQL each
// read sends (one row per part, no JOIN, every value bound), the totals and the
// rollup it builds from the grouped counts, the filters, pagination and row shape.

import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AdminPhotoCoverageController } from './admin-photo-coverage.controller';
import { AdminPhotoCoverageService } from './admin-photo-coverage.service';
import { ListPhotoCoverageQueryDto } from './dto/list-photo-coverage.query.dto';
import { DISPLAYABLE_PHOTO_URL_PATTERN } from './photo-coverage.rules';

const PHOTO = 'https://res.cloudinary.com/mator/image/upload/v1/products/a.png';
const PHOTO_2 =
  'https://res.cloudinary.com/mator/image/upload/v1/products/b.png';

const CATEGORY = (id: string, parentId: string | null, sortOrder = 0) => ({
  id,
  parentId,
  name: id,
  nameRu: `ru ${id}`,
  nameUz: `uz ${id}`,
  nameEn: `en ${id}`,
  isActive: true,
  sortOrder,
});

const PART = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Part ${id}`,
  oemNumbers: ['96484900'],
  gmNumbers: [],
  images: [PHOTO],
  category: {
    id: 'pads',
    parentId: 'brakes',
    name: 'pads',
    nameRu: 'Колодки',
    nameUz: 'Kolodkalar',
    nameEn: 'Pads',
  },
  ...over,
});

function makePrisma() {
  return {
    $queryRaw: jest.fn(),
    partCategory: { findMany: jest.fn().mockResolvedValue([]) },
    catalogPart: { findMany: jest.fn().mockResolvedValue([]) },
    stock: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

type Stub = ReturnType<typeof makePrisma>;

function service(prisma: Stub) {
  return new AdminPhotoCoverageService(prisma as never);
}

/** The Prisma.Sql of the n-th $queryRaw call. */
const sqlOf = (prisma: Stub, n: number) =>
  prisma.$queryRaw.mock.calls[n][0] as Prisma.Sql;

describe('AdminPhotoCoverageService.summary', () => {
  it('counts unique parts per category in one GROUP BY over catalog_parts, no JOIN', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockResolvedValue([]);
    await service(prisma).summary();

    const q = sqlOf(prisma, 0);
    expect(q.text).toContain(
      'FROM "catalog_parts" cp GROUP BY cp."category_id"',
    );
    expect(q.text).toContain('COUNT(*)::bigint AS "total"');
    expect(q.text).toContain(
      'COUNT(*) FILTER (WHERE COALESCE(cp."images"[array_lower(cp."images", 1)] ~* $1, false))',
    );
    expect(q.text).not.toMatch(/JOIN/i);
    expect(q.values).toEqual([DISPLAYABLE_PHOTO_URL_PATTERN]);
  });

  it('totals the grouped counts once each and rolls up the live tree', async () => {
    const prisma = makePrisma();
    // A part with 3 photos is one row in COUNT(*): the stub returns what the
    // GROUP BY would — per-category part counts, not photo counts.
    prisma.$queryRaw.mockResolvedValue([
      { categoryId: 'brakes', total: 1n, withPhotos: 0n },
      { categoryId: 'pads', total: 4n, withPhotos: 3n },
      { categoryId: 'engine', total: 5n, withPhotos: 5n },
    ]);
    prisma.partCategory.findMany.mockResolvedValue([
      CATEGORY('brakes', null, 1),
      CATEGORY('pads', 'brakes'),
      CATEGORY('discs', 'brakes', 1),
      CATEGORY('engine', null, 0),
    ]);

    const { data } = await service(prisma).summary();

    expect(data.totals).toEqual({
      total: 10,
      withPhotos: 8,
      withoutPhotos: 2,
      coveragePct: 80,
    });
    expect(
      data.categories.map((c) => [
        c.id,
        c.total,
        c.withPhotos,
        c.withoutPhotos,
      ]),
    ).toEqual([
      ['engine', 5, 5, 0],
      ['brakes', 5, 3, 2],
      ['pads', 4, 3, 1],
      ['discs', 0, 0, 0],
    ]);
    // Categories come from the tree read, never from main_category.
    expect(prisma.partCategory.findMany).toHaveBeenCalledWith({
      select: expect.objectContaining({ id: true, parentId: true }),
    });
  });

  it('reports a null coverage for an empty catalogue', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockResolvedValue([]);
    const { data } = await service(prisma).summary();
    expect(data.totals).toEqual({
      total: 0,
      withPhotos: 0,
      withoutPhotos: 0,
      coveragePct: null,
    });
  });
});

describe('AdminPhotoCoverageService.list', () => {
  function listPrisma(ids: string[], total: number) {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ count: BigInt(total) }])
      .mockResolvedValueOnce(ids.map((id) => ({ id })));
    return prisma;
  }

  it('without a filter: no WHERE, ordered page, 25 per page by default', async () => {
    const prisma = listPrisma([], 0);
    const res = await service(prisma).list({});

    expect(sqlOf(prisma, 0).text).toBe(
      'SELECT COUNT(*)::bigint AS count FROM "catalog_parts" cp ',
    );
    const page = sqlOf(prisma, 1);
    expect(page.text).toContain(
      'ORDER BY cp."title" ASC, cp."id" ASC LIMIT $1 OFFSET $2',
    );
    expect(page.values).toEqual([25, 0]);
    expect(res.meta).toEqual({
      page: 1,
      limit: 25,
      totalItems: 0,
      totalPages: 0,
    });
    expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
  });

  it('photo=without selects parts with NO displayable photo', async () => {
    const prisma = listPrisma([], 0);
    await service(prisma).list({ photo: 'without' });
    expect(sqlOf(prisma, 0).text).toContain(
      'WHERE NOT COALESCE(cp."images"[array_lower(cp."images", 1)] ~* $1, false)',
    );
    expect(sqlOf(prisma, 0).values).toEqual([DISPLAYABLE_PHOTO_URL_PATTERN]);
  });

  it('photo=with selects parts with a displayable photo; all adds no condition', async () => {
    const prisma = listPrisma([], 0);
    await service(prisma).list({ photo: 'with' });
    expect(sqlOf(prisma, 0).text).toContain(
      'WHERE COALESCE(cp."images"[array_lower(cp."images", 1)] ~* $1, false)',
    );

    const all = listPrisma([], 0);
    await service(all).list({ photo: 'all' });
    expect(sqlOf(all, 0).text).not.toContain('WHERE');
  });

  it('a category filter covers its whole subtree from the live tree', async () => {
    const prisma = listPrisma([], 0);
    prisma.partCategory.findMany.mockResolvedValue([
      { id: 'brakes', parentId: null },
      { id: 'pads', parentId: 'brakes' },
      { id: 'front-pads', parentId: 'pads' },
      { id: 'engine', parentId: null },
    ]);
    await service(prisma).list({ categoryId: 'brakes', photo: 'without' });

    const q = sqlOf(prisma, 0);
    expect(q.text).toContain('AND cp."category_id" IN ($2,$3,$4)');
    expect((q.values as string[]).slice(1).sort()).toEqual([
      'brakes',
      'front-pads',
      'pads',
    ]);
  });

  it('name, OEM and 1C searches are bound, escaped contains matches', async () => {
    const prisma = listPrisma([], 0);
    await service(prisma).list({
      name: ' колодки ',
      oem: '96_48',
      code1c: '000123',
    });

    const q = sqlOf(prisma, 0);
    expect(q.text).toContain('cp."title" ILIKE $1');
    expect(q.text).toContain('unnest(cp."oem_numbers")');
    expect(q.text).toContain('unnest(cp."gm_numbers")');
    expect(q.text).toContain('FROM "stocks" s');
    expect(q.text).toContain(`cp."id" = 'part_stock_' || s."id"::text`);
    expect(q.values).toEqual([
      '%колодки%',
      '%96\\_48%',
      '%96\\_48%',
      '%96\\_48%',
      'DRIVERS_VILLAGE_1C',
      '%000123%',
    ]);
  });

  it('pages with LIMIT/OFFSET and keeps the SQL order', async () => {
    const prisma = listPrisma(['part_b', 'part_a'], 60);
    prisma.catalogPart.findMany.mockResolvedValue([
      PART('part_a'),
      PART('part_b'),
    ]);
    const res = await service(prisma).list({ page: 3, limit: 20 });

    expect(sqlOf(prisma, 1).values).toEqual([20, 40]);
    expect(prisma.catalogPart.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['part_b', 'part_a'] } } }),
    );
    expect(res.data.map((r) => r.id)).toEqual(['part_b', 'part_a']);
    expect(res.meta).toEqual({
      page: 3,
      limit: 20,
      totalItems: 60,
      totalPages: 3,
    });
  });

  it('caps the page size at 100', async () => {
    const prisma = listPrisma([], 0);
    await service(prisma).list({ limit: 500 });
    expect(sqlOf(prisma, 1).values).toEqual([100, 0]);
  });

  it('decides the photo state on images[0] alone, like the app card', async () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    const prisma = listPrisma(ids, ids.length);
    prisma.catalogPart.findMany.mockResolvedValue([
      PART('p1', { images: [PHOTO, PHOTO_2] }),
      PART('p2', { images: [] }),
      PART('p3', { images: ['', 'http://old/x.png'] }),
      PART('p4', { images: null }),
      // A broken first entry hides a good second one from the buyer.
      PART('p5', { images: ['', PHOTO] }),
      PART('p6', { images: ['http://old/x.png', PHOTO, PHOTO_2] }),
      PART('p7', { images: [PHOTO, ''] }),
    ]);
    const { data } = await service(prisma).list({});

    expect(
      data.map((r) => [
        r.id,
        r.photoStatus,
        r.primaryPhoto,
        r.photoCount,
        r.storedPhotoCount,
      ]),
    ).toEqual([
      ['p1', 'has_photo', PHOTO, 2, 2],
      ['p2', 'no_photo', null, 0, 0],
      ['p3', 'no_photo', null, 0, 2],
      ['p4', 'no_photo', null, 0, 0],
      ['p5', 'no_photo', null, 1, 2],
      ['p6', 'no_photo', null, 2, 3],
      ['p7', 'has_photo', PHOTO, 1, 2],
    ]);
    // The operator's gallery still holds the good later photos.
    expect(data[4].photos).toEqual([PHOTO]);
    expect(data[5].photos).toEqual([PHOTO, PHOTO_2]);
    expect(data[2].photos).toEqual([]);
  });

  it('reads the 1C code of imported parts only, from their Stock', async () => {
    const prisma = listPrisma(
      ['part_stock_12', 'part_tg_1', 'part_stock_99'],
      3,
    );
    prisma.catalogPart.findMany.mockResolvedValue([
      PART('part_stock_12', { oemNumbers: [], gmNumbers: ['GM-1'] }),
      PART('part_tg_1'),
      PART('part_stock_99'),
    ]);
    prisma.stock.findMany.mockResolvedValue([
      { id: 12, sourceCode: '00-0012' },
    ]);
    const { data } = await service(prisma).list({});

    expect(prisma.stock.findMany).toHaveBeenCalledWith({
      where: { id: { in: [12, 99] }, sourceSystem: 'DRIVERS_VILLAGE_1C' },
      select: { id: true, sourceCode: true },
    });
    expect(data.map((r) => [r.id, r.code1c, r.oem])).toEqual([
      ['part_stock_12', '00-0012', 'GM-1'],
      ['part_tg_1', null, '96484900'],
      ['part_stock_99', null, '96484900'],
    ]);
  });
});

describe('ListPhotoCoverageQueryDto', () => {
  const errors = (plain: Record<string, unknown>) =>
    validateSync(plainToInstance(ListPhotoCoverageQueryDto, plain)).map(
      (e) => e.property,
    );

  it('accepts the documented filters', () => {
    expect(
      errors({ page: '2', limit: '50', photo: 'without', categoryId: 'pads' }),
    ).toEqual([]);
  });

  it('refuses an unknown photo filter and an oversized page', () => {
    expect(errors({ photo: 'some' })).toEqual(['photo']);
    expect(errors({ limit: '101' })).toEqual(['limit']);
    expect(errors({ page: '0' })).toEqual(['page']);
  });
});

describe('AdminPhotoCoverageController', () => {
  it('requires an admin token and the admin role guard on every route', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminPhotoCoverageController,
    ) as unknown[];
    expect(guards).toEqual([AdminJwtGuard, AdminRoleGuard]);
  });
});
