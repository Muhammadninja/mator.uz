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

describe('ReferenceService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let cache: ReturnType<typeof makeCacheMock>;
  let service: ReferenceService;

  beforeEach(() => {
    prisma = makePrismaMock();
    cache = makeCacheMock();
    service = new ReferenceService(prisma as never, cache as never);
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
        expect.objectContaining({ where: { makeId: 'chevrolet' }, orderBy: { sortOrder: 'asc' } }),
      );
      expect(res).toEqual({
        items: [{ id: 'cobalt', make_id: 'chevrolet', name: 'Cobalt' }],
        total: 1,
      });
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
});
