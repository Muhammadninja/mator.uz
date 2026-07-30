// "Real world cars" fitment scenarios — drives the REAL PartsService matching
// engine with authentic Uzbek-market Chevrolet data (trim/engine ids + a VIN
// straight from prisma/seed-data/vehicle-catalog.seed.ts). Where the synthetic
// check-compatibility.spec.ts pins the status→contract mapping, this pins the
// end-to-end fitment DECISION a buyer actually sees:
//
//   Chevrolet Cobalt 2022 (Premier, 1.5L NA) + Cobalt brake pads → EXACT_MATCH
//   Chevrolet Malibu 2020 (2.0T)             + Cobalt brake pads → NOT_COMPATIBLE
//   any car                                  + 5W-30 oil (universal) → UNIVERSAL
//   Cobalt (engine-only fit)                                       → UNCERTAIN
//   VIN of a Cobalt                          + Cobalt brake pads → EXACT_MATCH
//
// Prisma is stubbed per-case (no DB) but the service logic is the real thing.

import { CompatibilityStatus } from '@prisma/client';
import { PartsService } from './parts.service';

type CompatRow = {
  trimId: string | null;
  engineId: string | null;
  years: number[];
  status: CompatibilityStatus;
  confidence: number;
};

// ── Real seed cars (vehicle-catalog.seed.ts) ────────────────────────────────
const COBALT_2022 = {
  trimId: 'cobalt-p2-premier',
  engineId: 'b15d2-na', // 1.5L On-Turbo (B15D2)
  year: 2022,
  make: { name: 'Chevrolet' },
  model: { name: 'Cobalt' },
};
const MALIBU_2020 = {
  trimId: 'malibu-2-lt',
  engineId: 'malibu-2-0t', // 2.0L Turbo (LTG)
  year: 2020,
  make: { name: 'Chevrolet' },
  model: { name: 'Malibu' },
};
// A real GM-Uzbekistan Cobalt VIN prefix (WMI XWB = UzAuto Motors).
const COBALT_VIN = 'XWBLB69V6M0000123';

// ── Real parts ──────────────────────────────────────────────────────────────
const COBALT_BRAKE_PADS = {
  id: 'part_cobalt_front_pads',
  isUniversal: false,
  oemNumbers: ['13301234'],
  compatibilities: [
    // Fits the Cobalt Premier across all model years.
    { trimId: 'cobalt-p2-premier', engineId: null, years: [], status: CompatibilityStatus.FITS, confidence: 1 },
  ] as CompatRow[],
};
const OIL_5W30 = {
  id: 'part_oil_5w30',
  isUniversal: true,
  oemNumbers: [],
  compatibilities: [] as CompatRow[],
};
const ENGINE_ONLY_PART = {
  id: 'part_b15d2_coil',
  isUniversal: false,
  oemNumbers: ['25198623'],
  // Keyed only to the 1.5L B15D2 engine (no trim) → weaker than a trim match.
  compatibilities: [
    { trimId: null, engineId: 'b15d2-na', years: [], status: CompatibilityStatus.FITS, confidence: 1 },
  ] as CompatRow[],
};

function makeService(opts: {
  part: { id?: string; isUniversal: boolean; oemNumbers?: string[]; compatibilities?: CompatRow[] };
  vehicleById?: Record<string, unknown> | null;
  vehicleByVin?: Record<string, unknown> | null;
}) {
  const prisma = {
    catalogPart: {
      findUnique: jest.fn().mockResolvedValue({
        id: opts.part.id ?? 'part_1',
        isUniversal: opts.part.isUniversal,
        oemNumbers: opts.part.oemNumbers ?? [],
        compatibilities: opts.part.compatibilities ?? [],
      }),
    },
    vehicle: {
      findUnique: jest.fn().mockResolvedValue(opts.vehicleById ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.vehicleByVin ?? null),
    },
  };
  return { svc: new PartsService(prisma as never), prisma };
}

describe('Real-world fitment — Chevrolet garage', () => {
  it('Cobalt 2022 (Premier, 1.5L) + Cobalt brake pads → EXACT_MATCH (green, buyable)', async () => {
    const { svc } = makeService({ part: COBALT_BRAKE_PADS, vehicleById: COBALT_2022 });
    const res = await svc.checkCompatibility(COBALT_BRAKE_PADS.id, { vehicleId: 'veh_cobalt' });
    expect(res.status).toBe('EXACT_MATCH');
    expect(res.isCompatible).toBe(true);
    expect(res.badge.color).toBe('green');
    expect(res.details).toEqual({ matchedBy: 'MODEL_REF', oemNumber: '13301234' });
  });

  it('Malibu 2020 (2.0T) + Cobalt brake pads → NOT_COMPATIBLE (red, Safety Gate)', async () => {
    const { svc } = makeService({ part: COBALT_BRAKE_PADS, vehicleById: MALIBU_2020 });
    const res = await svc.checkCompatibility(COBALT_BRAKE_PADS.id, { vehicleId: 'veh_malibu' });
    expect(res.status).toBe('NOT_COMPATIBLE');
    expect(res.isCompatible).toBe(false);
    expect(res.badge.color).toBe('red');
  });

  it('5W-30 motor oil is UNIVERSAL for any car (green), even a Malibu', async () => {
    const { svc } = makeService({ part: OIL_5W30, vehicleById: MALIBU_2020 });
    const res = await svc.checkCompatibility(OIL_5W30.id, { vehicleId: 'veh_malibu' });
    expect(res.status).toBe('UNIVERSAL');
    expect(res.isCompatible).toBe(true);
    expect(res.badge).toEqual({ text: 'Универсальный товар', color: 'green' });
    expect(res.details.matchedBy).toBe('UNIVERSAL');
  });

  it('Cobalt 2022 + a 1.5L engine-only coil → UNCERTAIN (yellow — engine matches, trim unconfirmed)', async () => {
    const { svc } = makeService({ part: ENGINE_ONLY_PART, vehicleById: COBALT_2022 });
    const res = await svc.checkCompatibility(ENGINE_ONLY_PART.id, { vehicleId: 'veh_cobalt' });
    expect(res.status).toBe('UNCERTAIN');
    expect(res.badge.color).toBe('yellow');
  });

  it('resolves a Cobalt by its real VIN and confirms the brake-pad fit → EXACT_MATCH', async () => {
    const { svc, prisma } = makeService({ part: COBALT_BRAKE_PADS, vehicleByVin: COBALT_2022 });
    const res = await svc.checkCompatibility(COBALT_BRAKE_PADS.id, { vin: COBALT_VIN });
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { vin: COBALT_VIN } }),
    );
    expect(res.status).toBe('EXACT_MATCH');
    expect(res.isCompatible).toBe(true);
  });

  it('brake pads with NO garage vehicle selected → UNCERTAIN (never a false red)', async () => {
    const { svc } = makeService({ part: COBALT_BRAKE_PADS, vehicleById: null });
    const res = await svc.checkCompatibility(COBALT_BRAKE_PADS.id, {});
    expect(res.status).toBe('UNCERTAIN');
    expect(res.isCompatible).toBe(true);
  });
});
