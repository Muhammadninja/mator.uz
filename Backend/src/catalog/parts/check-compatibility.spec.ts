// Tests for the app-facing `POST :id/check-compatibility` mapping — the crux of
// the buyer "Check If It Fits" contract. We assert the internal fit status is
// projected onto the right contract status + badge + details, that universal
// parts short-circuit, that a VIN resolves a vehicle, and that a missing part
// 404s. Prisma is stubbed per-case (no DB).

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
            }
          : null,
      ),
    },
    vehicle: {
      findUnique: jest.fn().mockResolvedValue(opts.vehicleById ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.vehicleByVin ?? null),
    },
  };
  // Compatibility never prices a part, so a bare DiscountService stub suffices.
  return { svc: new PartsService(prisma as never, {} as never), prisma };
}

const VEHICLE = {
  trimId: 't1',
  engineId: 'e1',
  year: 2022,
  make: { name: 'Chevrolet' },
  model: { name: 'Cobalt' },
};

describe('PartsService.checkCompatibility — contract mapping', () => {
  it('universal part → UNIVERSAL / green, regardless of vehicle', async () => {
    const { svc } = makeService({ part: { isUniversal: true }, vehicleById: null });
    const res = await svc.checkCompatibility('part_1', { vehicleId: 'v1' });
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
    const res = await svc.checkCompatibility('part_1', { vehicleId: 'v1' });
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
    const res = await svc.checkCompatibility('part_1', { vehicleId: 'v1' });
    expect(res.status).toBe('NOT_COMPATIBLE');
    expect(res.isCompatible).toBe(false);
    expect(res.badge.color).toBe('red');
  });

  it('no compatibility data + a vehicle → UNCERTAIN / yellow', async () => {
    const { svc } = makeService({
      part: { isUniversal: false, compatibilities: [] },
      vehicleById: VEHICLE,
    });
    const res = await svc.checkCompatibility('part_1', { vehicleId: 'v1' });
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
    const res = await svc.checkCompatibility('part_1', { vin: 'WVWZZZ1KZAW000001' });
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { vin: 'WVWZZZ1KZAW000001' } }),
    );
    expect(res.status).toBe('EXACT_MATCH');
  });

  it('echoes the part first OEM number in details', async () => {
    const { svc } = makeService({
      part: { isUniversal: false, oemNumbers: ['96484900', '96484901'], compatibilities: [] },
      vehicleById: VEHICLE,
    });
    const res = await svc.checkCompatibility('part_1', { vehicleId: 'v1' });
    expect(res.details.oemNumber).toBe('96484900');
  });

  it('throws NotFound when the part does not exist', async () => {
    const { svc } = makeService({ part: null });
    await expect(svc.checkCompatibility('nope', { vehicleId: 'v1' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
