// Regression: «По моей модели · Tracker» listed Driver's Village parts whose
// badge said «Совместимость не установлена». The owner corrected and
// re-imported that dealer's fitment, so its per-model rows are verified
// (VERIFIED_FITMENT_SELLER_IDS); every other source keeps its old meaning.
//
// Production facts these fixtures mirror (2026-11-13): `tracker` and
// `tracker-2` are two Chevrolet models both named "Tracker", with no years and
// no generation rows; the import stores TRACKER-1 / TRACKER-2 as "Tracker"
// (a part for one fits both, per the owner); prod has no curated bindings or
// trim rows for either id.
//
// Tracker and Tracker 2 share parts: a part proven for both (a dealer "Tracker"
// row, or curated bindings to both ids) is listed and EXACT_MATCH for both
// owners; a part curated to one id never reaches the other. An admin MAYBE
// binding is never EXACT_MATCH, and still overrides a dealer row.
//
// The listing (vehicleFitWhere), the badge (computeCompatibility via
// checkCompatibility) and the facet (compatibilityFacetWhere) are run over the
// same in-memory parts, so the three are proven to agree, not just shaped alike.

import { CompatibilityStatus } from '@prisma/client';
import { computeCompatibility, curatedFitment } from '../parts/part.presenter';
import { PartsService } from '../parts/parts.service';
import { part } from './fitment-fixtures.test-util';
import {
  compatibilityFacetWhere,
  hasVerifiedSourceFit,
  toVehicleFitContext,
  VehicleFitContext,
  VehicleFitRow,
  vehicleFitWhere,
} from './vehicle-fitment';
import { selectIds } from './where-eval.test-util';

const DV = 'drivers-village';
const TELEGRAM_SELLER = 'seller_7';

type Spec = Parameters<typeof part>[0] & {
  sellerId: string;
  /** Admin bindings with their status, [VehicleModelRef id, status]. */
  bindings?: [string, 'EXACT_MATCH' | 'MAYBE'][];
  trimRows?: { trimId: string; years: number[]; status: CompatibilityStatus }[];
};

/** A catalog part with its dealer and (optionally) year-scoped trim rows. */
function dealerPart(spec: Spec) {
  const base = part(spec);
  return {
    ...base,
    sellerId: spec.sellerId,
    ...(spec.bindings
      ? {
          fitmentBindings: spec.bindings.map(([vehicleModelId, status]) => ({
            vehicleModelId,
            status,
          })),
        }
      : {}),
    compatibilities: (spec.trimRows ?? []).map((r) => ({
      trimId: r.trimId,
      engineId: null,
      years: r.years,
      status: r.status,
      confidence: 1,
    })),
  };
}

const CATALOG = [
  dealerPart({
    id: 'dv_tracker',
    sellerId: DV,
    fits: [['Chevrolet', 'Tracker']],
  }),
  dealerPart({
    id: 'dv_cobalt_and_tracker',
    sellerId: DV,
    fits: [
      ['Chevrolet', 'Cobalt'],
      ['Chevrolet', 'Tracker'],
    ],
  }),
  // Case differences in the stored names do not matter (the listing's match is
  // case-insensitive too).
  dealerPart({
    id: 'dv_tracker_upper',
    sellerId: DV,
    fits: [['CHEVROLET', 'TRACKER']],
  }),
  // Rows that name other models: not listed for a Tracker, and not a "no".
  dealerPart({
    id: 'dv_cobalt_only',
    sellerId: DV,
    fits: [['Chevrolet', 'Cobalt']],
  }),
  // Another make's "Tracker": the make must match too.
  dealerPart({
    id: 'dv_other_make_tracker',
    sellerId: DV,
    fits: [['Kia', 'Tracker']],
  }),
  // Make-wide: listed for every Chevrolet, never a confirmed fit.
  dealerPart({ id: 'dv_makewide', sellerId: DV, makeFits: ['Chevrolet'] }),
  // The same row from an unverified Telegram seller: listed, unconfirmed.
  dealerPart({
    id: 'tg_tracker',
    sellerId: TELEGRAM_SELLER,
    fits: [['Chevrolet', 'Tracker']],
  }),
  dealerPart({ id: 'dv_universal_oil', sellerId: DV, isUniversal: true }),
  dealerPart({ id: 'dv_no_fitment', sellerId: DV }),
  // Curated to tracker-2 only: curation overrides the dealer's "Tracker" row.
  dealerPart({
    id: 'dv_curated_tracker2',
    sellerId: DV,
    curated: ['tracker-2'],
    fits: [['Chevrolet', 'Tracker']],
  }),
  // An explicit trim row saying it does NOT fit the 2016 Premier wins over the
  // dealer's model-level row, for that trim and year only.
  dealerPart({
    id: 'dv_tracker_trim_no_2016',
    sellerId: DV,
    fits: [['Chevrolet', 'Tracker']],
    trimRows: [
      {
        trimId: 'tracker-3-premier',
        years: [2016],
        status: CompatibilityStatus.DOES_NOT_FIT,
      },
    ],
  }),
  // Admin-curated to BOTH Tracker ids (from an unverified seller, so the
  // bindings alone are the evidence): shared by both owners.
  dealerPart({
    id: 'curated_both_trackers',
    sellerId: TELEGRAM_SELLER,
    bindings: [
      ['tracker', 'EXACT_MATCH'],
      ['tracker-2', 'EXACT_MATCH'],
    ],
  }),
  // Admin-curated to the first Tracker only.
  dealerPart({
    id: 'curated_tracker_only',
    sellerId: DV,
    bindings: [['tracker', 'EXACT_MATCH']],
    fits: [['Chevrolet', 'Tracker']],
  }),
  // The admin was unsure (MAYBE) about the first Tracker: that overrides the
  // dealer's "Tracker" row, and is never a confirmed fit.
  dealerPart({
    id: 'maybe_tracker_over_dealer',
    sellerId: DV,
    bindings: [['tracker', 'MAYBE']],
    fits: [['Chevrolet', 'Tracker']],
  }),
  // MAYBE at one 3D node, EXACT_MATCH at another, same model: confirmed.
  dealerPart({
    id: 'maybe_and_exact_tracker',
    sellerId: DV,
    bindings: [
      ['tracker', 'MAYBE'],
      ['tracker', 'EXACT_MATCH'],
    ],
  }),
  // Confirmed for Tracker, MAYBE for Tracker 2.
  dealerPart({
    id: 'exact_tracker_maybe_tracker2',
    sellerId: DV,
    bindings: [
      ['tracker', 'EXACT_MATCH'],
      ['tracker-2', 'MAYBE'],
    ],
  }),
  // Generation rows: the dealer filed it under the resolved generation's name.
  dealerPart({
    id: 'dv_nexia3',
    sellerId: DV,
    fits: [['Chevrolet', 'Nexia 3']],
  }),
];

const NEXIA_VARIANTS = [
  {
    id: 'nexia-2',
    makeId: 'chevrolet',
    name: 'Nexia 2',
    bodyType: null,
    yearFrom: 2008,
    yearTo: 2016,
  },
  {
    id: 'nexia-3',
    makeId: 'chevrolet',
    name: 'Nexia 3',
    bodyType: 'Sedan',
    yearFrom: 2016,
    yearTo: 2022,
  },
];

/** A Garage row as VEHICLE_FIT_SELECT returns it. */
function garageRow(
  modelId: string,
  modelName: string,
  year: number,
  trimId: string | null = null,
  variants: NonNullable<VehicleFitRow['model']>['variants'] = [],
): VehicleFitRow {
  return {
    modelId,
    trimId,
    engineId: null,
    year,
    variantModelId: null,
    make: { name: 'Chevrolet' },
    model: { name: modelName, variants },
  };
}

const V = {
  tracker2016: toVehicleFitContext(garageRow('tracker', 'Tracker', 2016)),
  tracker2016Premier: toVehicleFitContext(
    garageRow('tracker', 'Tracker', 2016, 'tracker-3-premier'),
  ),
  tracker2018Premier: toVehicleFitContext(
    garageRow('tracker', 'Tracker', 2018, 'tracker-3-premier'),
  ),
  tracker2_2023: toVehicleFitContext(garageRow('tracker-2', 'Tracker', 2023)),
  nexia2019: toVehicleFitContext(
    garageRow('nexia', 'Nexia', 2019, null, NEXIA_VARIANTS),
  ),
  nexia2010: toVehicleFitContext(
    garageRow('nexia', 'Nexia', 2010, null, NEXIA_VARIANTS),
  ),
};

type Row = (typeof CATALOG)[number];
const byId = (id: string): Row => {
  const p = CATALOG.find((x) => x.id === id);
  if (!p) throw new Error(`no fixture ${id}`);
  return p;
};

/** The badge's internal status, exactly as the presenter and checks compute it. */
function badge(id: string, v: VehicleFitContext): string {
  const p = byId(id);
  return (
    computeCompatibility(
      p.compatibilities as never,
      v,
      curatedFitment(p),
      hasVerifiedSourceFit(p, v),
    )?.status ?? 'maybe'
  );
}

const listed = (v: VehicleFitContext) => selectIds(CATALOG, vehicleFitWhere(v));

function facetBucket(id: string, v: VehicleFitContext): string {
  const facet = compatibilityFacetWhere(v);
  const p = [byId(id)];
  const fits = selectIds(p, facet.fits).length > 0;
  const no = selectIds(p, facet.doesNotFit).length > 0;
  if (fits && no) throw new Error(`${id} counted in both buckets`);
  return fits ? 'fits' : no ? 'does_not_fit' : 'maybe';
}

describe("Tracker compatibility (verified Driver's Village fitment)", () => {
  it.each([
    ['tracker2016', 'dv_tracker'],
    ['tracker2016', 'dv_cobalt_and_tracker'],
    ['tracker2016', 'dv_tracker_upper'],
    ['tracker2_2023', 'dv_tracker'],
    ['tracker2_2023', 'dv_cobalt_and_tracker'],
  ] as const)('%s: %s is a confirmed fit and listed', (vk, id) => {
    expect(badge(id, V[vk])).toBe('fits');
    expect(listed(V[vk])).toContain(id);
  });

  it('a "Tracker" row confirms both Tracker reference rows, whatever the year', () => {
    for (const v of [V.tracker2016, V.tracker2018Premier, V.tracker2_2023]) {
      expect(badge('dv_tracker', v)).toBe('fits');
    }
  });

  it('the same row from an unverified Telegram seller is listed but stays unknown', () => {
    expect(listed(V.tracker2016)).toContain('tg_tracker');
    expect(badge('tg_tracker', V.tracker2016)).toBe('maybe');
  });

  it('a make-wide dealer row is listed but never a confirmed fit', () => {
    expect(listed(V.tracker2016)).toContain('dv_makewide');
    expect(badge('dv_makewide', V.tracker2016)).toBe('maybe');
  });

  it('a dealer part for other models is not listed and is unknown, not "does not fit"', () => {
    expect(listed(V.tracker2016)).not.toContain('dv_cobalt_only');
    expect(badge('dv_cobalt_only', V.tracker2016)).toBe('maybe');
    expect(listed(V.tracker2016)).not.toContain('dv_other_make_tracker');
    expect(badge('dv_other_make_tracker', V.tracker2016)).toBe('maybe');
  });

  it('a part with no fitment is not listed and stays unknown', () => {
    expect(listed(V.tracker2016)).not.toContain('dv_no_fitment');
    expect(badge('dv_no_fitment', V.tracker2016)).toBe('maybe');
  });

  it('a universal part is listed for every Tracker', () => {
    expect(listed(V.tracker2016)).toContain('dv_universal_oil');
    expect(listed(V.tracker2_2023)).toContain('dv_universal_oil');
  });

  it('a curated binding to tracker-2 overrides the dealer row', () => {
    expect(badge('dv_curated_tracker2', V.tracker2_2023)).toBe('fits');
    expect(listed(V.tracker2_2023)).toContain('dv_curated_tracker2');
    expect(badge('dv_curated_tracker2', V.tracker2016)).toBe('does_not_fit');
    expect(listed(V.tracker2016)).not.toContain('dv_curated_tracker2');
  });

  it('shared parts: proven for both Tracker ids → listed and a fit for both owners', () => {
    for (const id of ['dv_tracker', 'curated_both_trackers']) {
      for (const v of [V.tracker2016, V.tracker2_2023]) {
        expect([id, badge(id, v)]).toEqual([id, 'fits']);
        expect(listed(v)).toContain(id);
      }
    }
  });

  it('separate parts: curated to one Tracker id never reaches the other', () => {
    expect(badge('curated_tracker_only', V.tracker2016)).toBe('fits');
    expect(listed(V.tracker2016)).toContain('curated_tracker_only');
    // The dealer's "Tracker" row does not carry it over to Tracker 2.
    expect(badge('curated_tracker_only', V.tracker2_2023)).toBe('does_not_fit');
    expect(listed(V.tracker2_2023)).not.toContain('curated_tracker_only');

    expect(badge('dv_curated_tracker2', V.tracker2_2023)).toBe('fits');
    expect(listed(V.tracker2016)).not.toContain('dv_curated_tracker2');
  });

  it('MAYBE: an unsure admin binding is never a confirmed fit, and beats a dealer row', () => {
    expect(badge('maybe_tracker_over_dealer', V.tracker2016)).toBe('maybe');
    // Still listed: the admin put it on this model, just without certainty.
    expect(listed(V.tracker2016)).toContain('maybe_tracker_over_dealer');
    // Curated to the first Tracker only, so not a Tracker 2 part either.
    expect(badge('maybe_tracker_over_dealer', V.tracker2_2023)).toBe(
      'does_not_fit',
    );
  });

  it('MAYBE: one confirmed binding to the same model is enough', () => {
    expect(badge('maybe_and_exact_tracker', V.tracker2016)).toBe('fits');
    expect(badge('exact_tracker_maybe_tracker2', V.tracker2016)).toBe('fits');
    expect(badge('exact_tracker_maybe_tracker2', V.tracker2_2023)).toBe(
      'maybe',
    );
    expect(listed(V.tracker2_2023)).toContain('exact_tracker_maybe_tracker2');
  });

  it('an explicit trim row "does not fit" wins for its trim and year only', () => {
    expect(badge('dv_tracker_trim_no_2016', V.tracker2016Premier)).toBe(
      'does_not_fit',
    );
    expect(badge('dv_tracker_trim_no_2016', V.tracker2018Premier)).toBe('fits');
    expect(badge('dv_tracker_trim_no_2016', V.tracker2016)).toBe('fits');
  });

  it('generations: a dealer row under the resolved generation confirms only that generation', () => {
    expect(V.nexia2019.generationModelName).toBe('Nexia 3');
    expect(badge('dv_nexia3', V.nexia2019)).toBe('fits');
    expect(listed(V.nexia2019)).toContain('dv_nexia3');
    expect(V.nexia2010.generationModelName).toBe('Nexia 2');
    expect(badge('dv_nexia3', V.nexia2010)).toBe('maybe');
    expect(listed(V.nexia2010)).not.toContain('dv_nexia3');
  });

  it('listing, badge and facet agree for every non-universal part and vehicle', () => {
    for (const [vk, v] of Object.entries(V)) {
      const seen = listed(v);
      for (const p of CATALOG.filter((x) => !x.isUniversal)) {
        const status = badge(p.id, v);
        expect([vk, p.id, facetBucket(p.id, v)]).toEqual([vk, p.id, status]);
        // A confirmed fit is never missing from the vehicle's list.
        if (status === 'fits')
          expect([vk, seen]).toEqual([vk, expect.arrayContaining([p.id])]);
      }
    }
  });
});

describe('checkCompatibility (the app badge) for a Tracker owner', () => {
  const TRACKER_ROW = garageRow('tracker', 'Tracker', 2016);

  function service(row: Row) {
    const prisma = {
      partCategory: { findMany: jest.fn().mockResolvedValue([]) },
      catalogPart: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ ...row, categoryId: 'cat', oemNumbers: [] }),
      },
      vehicle: { findFirst: jest.fn().mockResolvedValue(TRACKER_ROW) },
    };
    return new PartsService(prisma as never, {} as never);
  }

  it.each([
    ['dv_tracker', 'EXACT_MATCH', true],
    ['tg_tracker', 'UNCERTAIN', false],
    ['dv_makewide', 'UNCERTAIN', false],
    ['dv_no_fitment', 'UNCERTAIN', false],
    ['dv_universal_oil', 'UNIVERSAL', true],
    ['dv_curated_tracker2', 'NOT_COMPATIBLE', false],
    ['curated_both_trackers', 'EXACT_MATCH', true],
    ['curated_tracker_only', 'EXACT_MATCH', true],
    ['maybe_tracker_over_dealer', 'UNCERTAIN', false],
    ['maybe_and_exact_tracker', 'EXACT_MATCH', true],
  ] as const)('%s → %s', async (id, status, isCompatible) => {
    const res = await service(byId(id)).checkCompatibility(
      id,
      { vehicleId: 'v1' },
      'user_1',
    );
    expect(res.status).toBe(status);
    expect(res.isCompatible).toBe(isCompatible);
  });

  it('a MAYBE binding read through the GET compatibility endpoint is "maybe", not "fits"', async () => {
    const row = byId('maybe_tracker_over_dealer');
    const prisma = {
      partCategory: { findMany: jest.fn().mockResolvedValue([]) },
      catalogPart: {
        findFirst: jest.fn().mockResolvedValue({ ...row, categoryId: 'cat' }),
      },
      vehicle: { findFirst: jest.fn().mockResolvedValue(TRACKER_ROW) },
    };
    const svc = new PartsService(prisma as never, {} as never);
    const res = await svc.compatibility(row.id, 'v1', 'user_1');
    expect(res.status).toBe('maybe');
    expect(res.source).not.toBe('fitment');
    const [{ include }] = prisma.catalogPart.findFirst.mock.calls[0] as [
      { include: { fitmentBindings: { select: Record<string, boolean> } } },
    ];
    expect(include.fitmentBindings.select).toMatchObject({ status: true });
  });

  it('an anonymous caller still gets UNCERTAIN for a verified dealer part', async () => {
    const res = await service(byId('dv_tracker')).checkCompatibility(
      'dv_tracker',
      { vehicleId: 'v1' },
      null,
    );
    expect(res.status).toBe('UNCERTAIN');
  });
});
