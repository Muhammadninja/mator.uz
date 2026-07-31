// Tests for the dynamic category tree's RULES — level derivation, cycle
// prevention, the active-only reads the seller bot depends on, the lineage
// validation that guards product creation, and cache invalidation on writes.
// Pure logic against mocked Prisma/Cache — no DB, no HTTP.

import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  MAX_DEPTH,
  PartCategoryService,
  buildTree,
  type CategoryRow,
} from './part-category.service';
import { RedisKeys } from '../../redis/redis.keys';

/** A category row as Prisma would return it under CATEGORY_SELECT. */
const row = (over: Partial<CategoryRow> & { id: string }): CategoryRow => ({
  name: over.id,
  slug: over.id,
  parentId: null,
  level: 0,
  sortOrder: 0,
  isActive: true,
  ...over,
});

// The seeded shape: root → main category → subcategory.
const TREE: CategoryRow[] = [
  row({ id: 'brake-system', level: 0 }),
  row({ id: 'brakes', parentId: 'brake-system', level: 1 }),
  row({ id: 'brake-pads', parentId: 'brakes', level: 2 }),
  row({ id: 'maintenance-and-fluids', level: 0 }),
  row({ id: 'oil-filters', parentId: 'maintenance-and-fluids', level: 1 }),
  row({ id: 'hidden', parentId: 'brake-system', level: 1, isActive: false }),
];

function makePrismaMock(rows: CategoryRow[] = TREE) {
  return {
    partCategory: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
      ),
      findMany: jest.fn(
        ({ where }: { where?: Record<string, unknown> } = {}) => {
          let out = rows;
          if (where && 'parentId' in where) {
            out = out.filter((r) => r.parentId === where.parentId);
          }
          if (where && 'level' in where) {
            out = out.filter((r) => r.level === where.level);
          }
          if (where?.isActive === true) out = out.filter((r) => r.isActive);
          return Promise.resolve(out);
        },
      ),
    },
  };
}

function makeCacheMock() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    // Read-through: always a miss, so the loader runs (the caching itself is
    // covered by cache.service.spec.ts).
    remember: jest.fn(
      async (_k: string, _ttl: number, loader: () => Promise<unknown>) =>
        loader(),
    ),
  };
}

function makeService(rows: CategoryRow[] = TREE) {
  const prisma = makePrismaMock(rows);
  const cache = makeCacheMock();
  const service = new PartCategoryService(prisma as never, cache as never);
  return { service, prisma, cache };
}

describe('PartCategoryService reads', () => {
  it('findRootCategories returns only ACTIVE level-0 rows', async () => {
    const { service, prisma } = makeService();
    const roots = await service.findRootCategories();
    expect(prisma.partCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ parentId: null, isActive: true }),
      }),
    );
    expect(roots.map((r) => r.id)).toEqual([
      'brake-system',
      'maintenance-and-fluids',
    ]);
  });

  it('excludes the parentless cat_uncategorized bucket from the roots', async () => {
    // It is an internal fallback for unclassified buyer parts, not a taxonomy a
    // seller may pick — so it is level 1 despite having no parent, and the
    // level-0 filter is what keeps it out of the bot's first step.
    const withBucket = [
      ...TREE,
      row({ id: 'cat_uncategorized', level: 1, parentId: null }),
    ];
    const { service } = makeService(withBucket);
    const roots = await service.findRootCategories();
    expect(roots.map((r) => r.id)).not.toContain('cat_uncategorized');
  });

  it('findChildren never returns an INACTIVE category to the seller bot', async () => {
    const { service } = makeService();
    const children = await service.findChildren('brake-system');
    expect(children.map((c) => c.id)).toEqual(['brakes']);
    expect(children.map((c) => c.id)).not.toContain('hidden');
  });

  it('findChildren returns an empty list for a leaf (the skip-the-step signal)', async () => {
    const { service } = makeService();
    expect(await service.findChildren('brake-pads')).toEqual([]);
  });

  it('caches root and children reads under their own keys', async () => {
    const { service, cache } = makeService();
    await service.findRootCategories();
    await service.findChildren('brakes');
    expect(cache.remember).toHaveBeenCalledWith(
      RedisKeys.cacheReferenceCategories(),
      expect.any(Number),
      expect.any(Function),
    );
    expect(cache.remember).toHaveBeenCalledWith(
      RedisKeys.cacheReferenceCategoryChildren('brakes'),
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('getOrFail 404s on an unknown id', async () => {
    const { service } = makeService();
    await expect(service.getOrFail('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('level derivation (never trusted from the client)', () => {
  it('a root category is level 0', async () => {
    const { service } = makeService();
    expect(await service.validateParent(null)).toBe(0);
    expect(await service.validateParent(undefined)).toBe(0);
  });

  it('a child is parent.level + 1', async () => {
    const { service } = makeService();
    expect(await service.validateParent('brake-system')).toBe(1); // main category
    expect(await service.validateParent('brakes')).toBe(2); // subcategory
  });

  it('rejects an unknown parent', async () => {
    const { service } = makeService();
    await expect(service.validateParent('ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects nesting deeper than the cap', async () => {
    const deep = [row({ id: 'too-deep', level: MAX_DEPTH })];
    const { service } = makeService(deep);
    await expect(service.validateParent('too-deep')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('cycle prevention', () => {
  it('rejects a category becoming its own parent', async () => {
    const { service } = makeService();
    await expect(
      service.validateMove('brakes', 'brakes'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a move under one of its own descendants', async () => {
    const { service } = makeService();
    // brake-system → brakes → brake-pads; moving the root under its grandchild
    // would detach the whole branch into a cycle.
    await expect(
      service.validateMove('brake-system', 'brake-pads'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a legitimate move and returns the derived level', async () => {
    const { service } = makeService();
    expect(await service.validateMove('oil-filters', 'brakes')).toBe(2);
  });

  it('allows promoting a category to root', async () => {
    const { service } = makeService();
    expect(await service.validateMove('brakes', null)).toBe(0);
  });

  it('descendantIds collects the whole subtree transitively', async () => {
    const { service } = makeService();
    const ids = await service.descendantIds('brake-system');
    expect([...ids].sort()).toEqual(['brake-pads', 'brakes', 'hidden']);
  });
});

describe('validateCategorySelection (the server-side backstop)', () => {
  it('accepts a category that descends from the vehicle category', async () => {
    const { service } = makeService();
    await expect(
      service.validateCategorySelection('brake-system', 'brake-pads'),
    ).resolves.toBeUndefined();
  });

  it('accepts a LEAF root chosen as its own category', async () => {
    const { service } = makeService();
    await expect(
      service.validateCategorySelection('brake-system', 'brake-system'),
    ).resolves.toBeUndefined();
  });

  it('REJECTS a category from a different vehicle category', async () => {
    // The §26 case: a malicious client pairing Brake System with Oil Filters.
    const { service } = makeService();
    await expect(
      service.validateCategorySelection('brake-system', 'oil-filters'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-root as the vehicle category', async () => {
    const { service } = makeService();
    await expect(
      service.validateCategorySelection('brakes', 'brake-pads'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an inactive category', async () => {
    const { service } = makeService();
    await expect(
      service.validateCategorySelection('brake-system', 'hidden'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on ids that do not exist at all', async () => {
    const { service } = makeService();
    await expect(
      service.validateCategorySelection('brake-system', 'forged'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('cache invalidation', () => {
  it('drops the roots key and every touched parent key', async () => {
    const { service, cache } = makeService();
    await service.invalidate('brake-system', 'brakes');
    expect(cache.delete).toHaveBeenCalledWith(
      RedisKeys.cacheReferenceCategories(),
    );
    expect(cache.delete).toHaveBeenCalledWith(
      RedisKeys.cacheReferenceCategoryChildren('brake-system'),
    );
    expect(cache.delete).toHaveBeenCalledWith(
      RedisKeys.cacheReferenceCategoryChildren('brakes'),
    );
  });

  it('ignores null/undefined parents (a root write has none)', async () => {
    const { service, cache } = makeService();
    await service.invalidate(null, undefined);
    expect(cache.delete).toHaveBeenCalledTimes(1); // the roots key only
  });
});

describe('buildTree', () => {
  it('nests children under their parents', () => {
    const forest = buildTree(TREE);
    expect(forest.map((n) => n.id)).toEqual([
      'brake-system',
      'maintenance-and-fluids',
    ]);
    const brakeSystem = forest[0];
    expect(brakeSystem.children.map((c) => c.id)).toEqual(['brakes', 'hidden']);
    expect(brakeSystem.children[0].children.map((c) => c.id)).toEqual([
      'brake-pads',
    ]);
  });

  it('drops a node whose parent is absent rather than promoting it to root', () => {
    // Promoting an orphan would misrepresent the tree (an inactive parent
    // filtered out of an activeOnly read must hide its whole subtree).
    const forest = buildTree([
      row({ id: 'orphan', parentId: 'missing', level: 1 }),
    ]);
    expect(forest).toEqual([]);
  });
});
