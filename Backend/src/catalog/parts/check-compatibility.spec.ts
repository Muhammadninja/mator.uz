// Tests for the app-facing `POST :id/check-compatibility` mapping — the crux of
// the buyer "Check If It Fits" contract. We assert the internal fit status is
// projected onto the right contract status + badge + details, that universal
// parts short-circuit, that a VIN resolves a vehicle (only in the caller's own
// garage), that a curated Fitment Studio binding answers EXACT_MATCH on its own,
// and that a missing part 404s. Prisma is stubbed per-case (no DB).

import { NotFoundException } from '@nestjs/common';
import { CompatibilityStatus } from '@prisma/client';
import { PartsService } from './parts.service';

type CompatRow = {
  trimId: string | null;
  engineId: string | null;
  years: number[];
  status: CompatibilityStatus;
  confidence: number;
  source?: string | null;
};

function makeService(opts: {
  part: {
    id?: string;
    isUniversal: boolean;
    oemNumbers?: string[];
    compatibilities?: CompatRow[];
    /** VehicleModelRef ids the part is curated to (fitment_bindings). */
    curatedModelIds?: string[];
  } | null;
  vehicleById?: Record<string, unknown> | null;
  vehicleByVin?: Record<string, unknown> | null;
}) {
  const prisma = {
    catalogPart: {
      findUnique: jest.fn().mockResolvedValue(
        opts.part
          ? {
              id: opts.part.id ?? 'part_1',
              isUniversal: opts.part.isUniversal,
              oemNumbers: opts.part.oemNumbers ?? [],
              compatibilities: opts.part.compatibilities ?? [],
              fitmentBindings: (opts.part.curatedModelIds ?? []).map(
                (vehicleModelId) => ({ vehicleModelId }),
              ),
            }
          : null,
      ),
    },
    vehicle: {
      findUnique: jest.fn().mockResolvedValue(opts.vehicleById ?? null),
      // Owned lookups go through findFirst; route on the key the service used.
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { vin?: string } }) =>
          Promise.resolve(
            where.vin !== undefined
              ? (opts.vehicleByVin ?? null)
              : (opts.vehicleById ?? null),
          ),
        ),
    },
  };
  // Compatibility never prices a part, so a bare DiscountService stub suffices.
  return { svc: new PartsService(prisma as never, {} as never), prisma };
}

/** The authenticated caller every vehicle-bearing check runs as. */
const USER = 'user_1';

const VEHICLE = {
  modelId: 'cobalt',
  trimId: 't1',
  engineId: 'e1',
  year: 2022,
  make: { name: 'Chevrolet' },
  model: { name: 'Cobalt' },
};

describe('PartsService.checkCompatibility — contract mapping', () => {
  it('universal part → UNIVERSAL / green, regardless of vehicle', async () => {
    const { svc } = makeService({ part: { isUniversal: true }, vehicleById: null });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res).toMatchObject({
      partId: 'part_1',
      status: 'UNIVERSAL',
      isCompatible: true,
      badge: { text: 'Универсальный товар', color: 'green' },
      details: { matchedBy: 'UNIVERSAL' },
    });
  });

  it('trim match (FITS) → EXACT_MATCH / green', async () => {
    const { svc } = makeService({
      part: {
        isUniversal: false,
        compatibilities: [
          { trimId: 't1', engineId: null, years: [], status: CompatibilityStatus.FITS, confidence: 1 },
        ],
      },
      vehicleById: VEHICLE,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res.status).toBe('EXACT_MATCH');
    expect(res.isCompatible).toBe(true);
    expect(res.badge.color).toBe('green');
  });

  it('explicit miss (rows exist, none match) → NOT_COMPATIBLE / red / isCompatible=false', async () => {
    const { svc } = makeService({
      part: {
        isUniversal: false,
        compatibilities: [
          { trimId: 't2', engineId: 'e2', years: [], status: CompatibilityStatus.FITS, confidence: 1 },
        ],
      },
      vehicleById: VEHICLE,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res.status).toBe('NOT_COMPATIBLE');
    expect(res.isCompatible).toBe(false);
    expect(res.badge.color).toBe('red');
  });

  it('no compatibility data + a vehicle → UNCERTAIN / yellow', async () => {
    const { svc } = makeService({
      part: { isUniversal: false, compatibilities: [] },
      vehicleById: VEHICLE,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res.status).toBe('UNCERTAIN');
    expect(res.badge.color).toBe('yellow');
  });

  it('no vehicle resolved (non-universal) → UNCERTAIN', async () => {
    const { svc } = makeService({
      part: { isUniversal: false, compatibilities: [] },
      vehicleById: null,
    });
    const res = await svc.checkCompatibility('part_1', {});
    expect(res.status).toBe('UNCERTAIN');
    expect(res.vehicleId).toBeNull();
  });

  it('resolves the vehicle by VIN (findFirst) when no vehicleId is given', async () => {
    const { svc, prisma } = makeService({
      part: {
        isUniversal: false,
        compatibilities: [
          { trimId: 't1', engineId: null, years: [2022], status: CompatibilityStatus.FITS, confidence: 1 },
        ],
      },
      vehicleByVin: VEHICLE,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vin: 'WVWZZZ1KZAW000001' },
      USER,
    );
    // Scoped to the caller's own, non-deleted garage — never any user's VIN.
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { vin: 'WVWZZZ1KZAW000001', userId: USER, deletedAt: null },
      }),
    );
    expect(res.status).toBe('EXACT_MATCH');
  });

  it('looks a vehicleId up ONLY in the caller garage', async () => {
    const { svc, prisma } = makeService({
      part: { isUniversal: false, compatibilities: [] },
      vehicleById: VEHICLE,
    });
    await svc.checkCompatibility('part_1', { vehicleId: 'v1' }, USER);
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'v1', userId: USER, deletedAt: null },
      }),
    );
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
  });

  it('an ANONYMOUS caller resolves no vehicle (no cross-user VIN lookup) → UNCERTAIN', async () => {
    const { svc, prisma } = makeService({
      part: {
        isUniversal: false,
        compatibilities: [
          {
            trimId: 't1',
            engineId: null,
            years: [],
            status: CompatibilityStatus.FITS,
            confidence: 1,
          },
        ],
      },
      vehicleByVin: VEHICLE,
    });
    const res = await svc.checkCompatibility('part_1', {
      vin: 'WVWZZZ1KZAW000001',
    });
    expect(prisma.vehicle.findFirst).not.toHaveBeenCalled();
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
    expect(res.status).toBe('UNCERTAIN');
  });

  it('a VIN from ANOTHER user garage does not resolve → UNCERTAIN', async () => {
    // findFirst scoped to USER finds nothing (the VIN belongs to someone else).
    const { svc } = makeService({
      part: {
        isUniversal: false,
        compatibilities: [
          {
            trimId: 't1',
            engineId: null,
            years: [],
            status: CompatibilityStatus.FITS,
            confidence: 1,
          },
        ],
      },
      vehicleByVin: null,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vin: 'XWB0THERUSER0001' },
      USER,
    );
    expect(res.status).toBe('UNCERTAIN');
  });

  it('echoes the part first OEM number in details', async () => {
    const { svc } = makeService({
      part: { isUniversal: false, oemNumbers: ['96484900', '96484901'], compatibilities: [] },
      vehicleById: VEHICLE,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res.details.oemNumber).toBe('96484900');
  });

  it('throws NotFound when the part does not exist', async () => {
    const { svc } = makeService({ part: null });
    await expect(
      svc.checkCompatibility('nope', { vehicleId: 'v1' }, USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PartsService.checkCompatibility — curated Fitment Studio bindings', () => {
  it('a binding to the vehicle model → EXACT_MATCH without any part_compatibilities row', async () => {
    const { svc } = makeService({
      part: {
        isUniversal: false,
        compatibilities: [],
        curatedModelIds: ['cobalt', 'gentra'],
      },
      vehicleById: VEHICLE, // modelId: 'cobalt'
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res.status).toBe('EXACT_MATCH');
    expect(res.isCompatible).toBe(true);
    expect(res.details.matchedBy).toBe('MODEL_REF');
  });

  it('curated to OTHER models only → NOT_COMPATIBLE, never EXACT_MATCH', async () => {
    const { svc } = makeService({
      part: {
        isUniversal: false,
        compatibilities: [],
        curatedModelIds: ['spark'],
      },
      vehicleById: VEHICLE,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res.status).toBe('NOT_COMPATIBLE');
    expect(res.isCompatible).toBe(false);
  });

  it('Nexia 2 binding never answers EXACT_MATCH for a Nexia 3 (distinct model ids)', async () => {
    const nexia3 = {
      ...VEHICLE,
      modelId: 'nexia-3',
      model: { name: 'Nexia 3' },
    };
    const { svc } = makeService({
      part: {
        isUniversal: false,
        compatibilities: [],
        curatedModelIds: ['nexia-2'],
      },
      vehicleById: nexia3,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res.status).toBe('NOT_COMPATIBLE');
  });

  it('no curated binding and no rows → still UNCERTAIN (unchanged)', async () => {
    const { svc } = makeService({
      part: { isUniversal: false, compatibilities: [], curatedModelIds: [] },
      vehicleById: VEHICLE,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res.status).toBe('UNCERTAIN');
  });

  it('a trim row still wins over curation (more specific evidence)', async () => {
    const { svc } = makeService({
      part: {
        isUniversal: false,
        compatibilities: [
          {
            trimId: 't1',
            engineId: null,
            years: [],
            status: CompatibilityStatus.DOES_NOT_FIT,
            confidence: 1,
          },
        ],
        curatedModelIds: ['cobalt'],
      },
      vehicleById: VEHICLE,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res.status).toBe('NOT_COMPATIBLE');
  });

  it('a universal part stays UNIVERSAL even when it carries bindings', async () => {
    const { svc } = makeService({
      part: { isUniversal: true, curatedModelIds: ['spark'] },
      vehicleById: VEHICLE,
    });
    const res = await svc.checkCompatibility(
      'part_1',
      { vehicleId: 'v1' },
      USER,
    );
    expect(res.status).toBe('UNIVERSAL');
  });
});
