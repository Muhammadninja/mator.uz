// Integration tests for the Buyer Reference API service (Phase 3). Prisma is
// mocked — no DB. These guard the four endpoints against regressions:
//   • ordering is always `sortOrder asc` (frontend catalog order)
//   • a missing/blank required id yields 400 (BadRequestException) and never
//     reaches Prisma (guards against the findUnique({id: undefined}) → 500 bug)
//   • unknown make/model/trim ids yield 404 (NotFoundException)
//   • engines?trimId validates existence only and never filters the list
//   • response field shapes stay snake_case + fuel_type lowercased

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReferenceService } from './reference.service';

function makePrismaMock() {
  return {
    vehicleMake: { findMany: jest.fn(), findUnique: jest.fn() },
    vehicleModelRef: { findMany: jest.fn(), findUnique: jest.fn() },
    vehicleTrim: { findMany: jest.fn(), findUnique: jest.fn() },
    vehicleEngine: { findMany: jest.fn() },
  };
}

/**
 * Pass-through CacheService double: always a miss, so the loader always runs and
 * the existing assertions on Prisma calls / response shapes hold unchanged. The
 * caching-specific behaviour (hit, miss, TTL, fail-open) is covered separately
 * in cache.service.spec.ts and in the dedicated block below with a stateful mock.
 */
function makeCacheMock() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    remember: jest.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) =>
      loader(),
    ),
  };
}

/**
 * The category tree is served through PartCategoryService (which owns its own
 * caching + invalidation), so ReferenceService only delegates to it. Mocking it
 * keeps these tests about the delegation contract; the tree rules themselves are
 * covered in part-category.service.spec.ts.
 */
function makeCategoriesMock() {
  return {
    getOrFail: jest.fn().mockResolvedValue({ id: 'brakes' }),
    findChildren: jest.fn().mockResolvedValue([]),
    findRootCategories: jest.fn().mockResolvedValue([]),
  };
}

describe('ReferenceService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let cache: ReturnType<typeof makeCacheMock>;
  let categories: ReturnType<typeof makeCategoriesMock>;
  let service: ReferenceService;

  beforeEach(() => {
    prisma = makePrismaMock();
    cache = makeCacheMock();
    categories = makeCategoriesMock();
    service = new ReferenceService(
      prisma as never,
      cache as never,
      categories as never,
    );
  });

  describe('listMakes', () => {
    it('returns makes ordered by sortOrder with snake_case fields', async () => {
      prisma.vehicleMake.findMany.mockResolvedValue([
        { id: 'chevrolet', name: 'Chevrolet', logoUrl: null },
        { id: 'byd', name: 'BYD', logoUrl: null },
      ]);
      const res = await service.listMakes();
      expect(prisma.vehicleMake.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { sortOrder: 'asc' } }),
      );
      expect(res).toEqual({
        items: [
          { id: 'chevrolet', name: 'Chevrolet', logo_url: null },
          { id: 'byd', name: 'BYD', logo_url: null },
        ],
        total: 2,
      });
    });
  });

  describe('listModels', () => {
    it('400s when makeId is missing/blank and never touches Prisma', async () => {
      for (const bad of [undefined, '']) {
        await expect(service.listModels(bad as never)).rejects.toBeInstanceOf(BadRequestException);
      }
      // A missing param must be rejected BEFORE any DB call (no findUnique → no 500).
      expect(prisma.vehicleMake.findUnique).not.toHaveBeenCalled();
      expect(prisma.vehicleModelRef.findMany).not.toHaveBeenCalled();
    });

    it('404s when the make is unknown', async () => {
      prisma.vehicleMake.findUnique.mockResolvedValue(null);
      await expect(service.listModels('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.vehicleModelRef.findMany).not.toHaveBeenCalled();
    });

    it('returns models for the make ordered by sortOrder', async () => {
      prisma.vehicleMake.findUnique.mockResolvedValue({ id: 'chevrolet' });
      prisma.vehicleModelRef.findMany.mockResolvedValue([
        { id: 'cobalt', makeId: 'chevrolet', name: 'Cobalt' },
      ]);
      const res = await service.listModels('chevrolet');
      expect(prisma.vehicleModelRef.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // Scoped to the make; the query also gates on the parent make's
          // isActive (inactive brands hide their models), so match on the
          // makeId scope rather than pinning the whole `where` shape.
          where: expect.objectContaining({ makeId: 'chevrolet' }),
          orderBy: { sortOrder: 'asc' },
        }),
      );
      expect(res).toEqual({
        items: [{ id: 'cobalt', make_id: 'chevrolet', name: 'Cobalt' }],
        total: 1,
      });
    });

    it('hides models whose parent make is inactive', async () => {
      prisma.vehicleMake.findUnique.mockResolvedValue({ id: 'chevrolet' });
      prisma.vehicleModelRef.findMany.mockResolvedValue([]);
      await service.listModels('chevrolet');
      // Models carry no active flag of their own — the parent make's isActive
      // gates them, so a deactivated brand drops out of the app catalog.
      expect(prisma.vehicleModelRef.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { makeId: 'chevrolet', make: { isActive: true } },
        }),
      );
    });
  });

  describe('listTrims', () => {
    it('400s when modelId is missing/blank and never touches Prisma', async () => {
      for (const bad of [undefined, '']) {
        await expect(service.listTrims(bad as never)).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(prisma.vehicleModelRef.findUnique).not.toHaveBeenCalled();
      expect(prisma.vehicleTrim.findMany).not.toHaveBeenCalled();
    });

    it('404s when the model is unknown', async () => {
      prisma.vehicleModelRef.findUnique.mockResolvedValue(null);
      await expect(service.listTrims('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.vehicleTrim.findMany).not.toHaveBeenCalled();
    });

    it('returns trims for the model ordered by sortOrder', async () => {
      prisma.vehicleModelRef.findUnique.mockResolvedValue({ id: 'cobalt' });
      prisma.vehicleTrim.findMany.mockResolvedValue([
        { id: 'cobalt-p2-premier', modelId: 'cobalt', name: 'Premier' },
      ]);
      const res = await service.listTrims('cobalt');
      expect(prisma.vehicleTrim.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { modelId: 'cobalt' }, orderBy: { sortOrder: 'asc' } }),
      );
      expect(res.items[0]).toEqual({ id: 'cobalt-p2-premier', model_id: 'cobalt', name: 'Premier' });
    });
  });

  describe('listEngines', () => {
    const engineRows = [
      { id: 'b15d2-na', name: '1.5L On-Turbo (B15D2)', displacementCc: 1500, fuelType: 'PETROL' },
      { id: 'byd-blade-ev', name: 'Blade Battery EV', displacementCc: null, fuelType: 'ELECTRIC' },
    ];

    it('returns all engines (no trimId) ordered by sortOrder, fuel_type lowercased', async () => {
      prisma.vehicleEngine.findMany.mockResolvedValue(engineRows);
      const res = await service.listEngines();
      expect(prisma.vehicleTrim.findUnique).not.toHaveBeenCalled();
      expect(prisma.vehicleEngine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { sortOrder: 'asc' } }),
      );
      expect(res.items).toEqual([
        { id: 'b15d2-na', name: '1.5L On-Turbo (B15D2)', displacement_cc: 1500, fuel_type: 'petrol' },
        { id: 'byd-blade-ev', name: 'Blade Battery EV', displacement_cc: null, fuel_type: 'electric' },
      ]);
    });

    it('404s when trimId is unknown', async () => {
      prisma.vehicleTrim.findUnique.mockResolvedValue(null);
      await expect(service.listEngines('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.vehicleEngine.findMany).not.toHaveBeenCalled();
    });

    it('validates a known trimId but still returns ALL engines (no filtering)', async () => {
      prisma.vehicleTrim.findUnique.mockResolvedValue({ id: 'cobalt-p2-premier' });
      prisma.vehicleEngine.findMany.mockResolvedValue(engineRows);
      const res = await service.listEngines('cobalt-p2-premier');
      expect(prisma.vehicleTrim.findUnique).toHaveBeenCalledWith({ where: { id: 'cobalt-p2-premier' } });
      // The full list is returned — trimId does not filter.
      expect(res.total).toBe(2);
    });
  });

  // The list reads go through CacheService.remember; validation stays uncached.
  describe('caching', () => {
    it('list reads go through remember() with the right key and 24h TTL', async () => {
      prisma.vehicleMake.findMany.mockResolvedValue([]);
      await service.listMakes();
      expect(cache.remember).toHaveBeenCalledWith(
        'cache:reference:makes',
        24 * 60 * 60,
        expect.any(Function),
      );

      prisma.vehicleMake.findUnique.mockResolvedValue({ id: 'chevrolet' });
      prisma.vehicleModelRef.findMany.mockResolvedValue([]);
      await service.listModels('chevrolet');
      expect(cache.remember).toHaveBeenCalledWith(
        'cache:reference:models:chevrolet',
        24 * 60 * 60,
        expect.any(Function),
      );
    });

    it('a cache HIT returns the cached payload and never touches Prisma', async () => {
      const cached = { items: [{ id: 'x', name: 'X', logo_url: null }], total: 1 };
      cache.remember.mockResolvedValueOnce(cached); // simulate a hit (loader skipped)

      const res = await service.listMakes();

      expect(res).toBe(cached);
      expect(prisma.vehicleMake.findMany).not.toHaveBeenCalled();
    });

    it('a cache MISS runs the loader once and returns the loaded value', async () => {
      prisma.vehicleMake.findMany.mockResolvedValue([
        { id: 'chevrolet', name: 'Chevrolet', logoUrl: null },
      ]);
      // Default mock = pass-through miss → loader runs.
      const res = await service.listMakes();
      expect(prisma.vehicleMake.findMany).toHaveBeenCalledTimes(1);
      expect(res).toEqual({
        items: [{ id: 'chevrolet', name: 'Chevrolet', logo_url: null }],
        total: 1,
      });
    });

    it('validation (404) runs BEFORE the cache — unknown ids never reach remember()', async () => {
      prisma.vehicleMake.findUnique.mockResolvedValue(null);
      await expect(service.listModels('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(cache.remember).not.toHaveBeenCalled();
    });

    it('engines use a single trim-independent cache key', async () => {
      prisma.vehicleTrim.findUnique.mockResolvedValue({ id: 't' });
      prisma.vehicleEngine.findMany.mockResolvedValue([]);
      await service.listEngines('t');
      expect(cache.remember).toHaveBeenCalledWith(
        'cache:reference:engines',
        24 * 60 * 60,
        expect.any(Function),
      );
    });
  });

  // The endpoint the Telegram seller bot walks. Category rules live in
  // PartCategoryService (mocked here) — these cover the delegation contract.
  describe('listCategories', () => {
    const brakes = {
      id: 'brakes',
      name: 'Brakes',
      slug: 'brakes',
      parentId: 'brake-system',
      level: 1,
      sortOrder: 0,
    };

    it('returns the ROOT categories when no parentId is given', async () => {
      categories.findRootCategories.mockResolvedValue([brakes]);
      const res = await service.listCategories();
      expect(categories.findRootCategories).toHaveBeenCalled();
      expect(res).toEqual({ items: [brakes], total: 1 });
    });

    it("returns a category's children when parentId is given", async () => {
      categories.findChildren.mockResolvedValue([brakes]);
      const res = await service.listCategories('brake-system');
      expect(categories.findChildren).toHaveBeenCalledWith('brake-system');
      expect(res).toEqual({ items: [brakes], total: 1 });
    });

    it('returns 200 with an empty list for a LEAF — the bot skips the step', async () => {
      categories.findChildren.mockResolvedValue([]);
      await expect(service.listCategories('brake-pads')).resolves.toEqual({
        items: [],
        total: 0,
      });
    });

    it('404s on an unknown parentId (matching makeId/modelId behaviour)', async () => {
      categories.getOrFail.mockRejectedValue(new NotFoundException());
      await expect(service.listCategories('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('400s on a blank parentId', async () => {
      await expect(service.listCategories('   ')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('never returns inactive categories (the service filters them out)', async () => {
      // findChildren/findRootCategories are active-only by construction; this
      // pins the contract that ReferenceService adds no inactive rows of its own.
      categories.findRootCategories.mockResolvedValue([brakes]);
      const res = await service.listCategories();
      expect(res.items.every((i) => !('isActive' in i))).toBe(true);
    });
  });
});
