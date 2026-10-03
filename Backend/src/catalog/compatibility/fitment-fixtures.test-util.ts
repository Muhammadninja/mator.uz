/**
 * TEST-ONLY fixtures for the buyer compatibility decision path.
 *
 * Reference ids follow the real VehicleModelRef rows: `cobalt`, `gentra`,
 * `spark`, and the SEPARATE `nexia-2` / `nexia-3` models (see
 * test/utils/vehicle-reference-fixture.ts). Parts carry every relation the
 * catalog filters touch, so where-eval can run the real predicates over them.
 */
import type { VehicleFitContext } from './vehicle-fitment';

type Ref = {
  id: string;
  name: string;
  makeId: string;
  make: { id: string; name: string };
};

const CHEVROLET = { id: 'chevrolet', name: 'Chevrolet' };
const KIA = { id: 'kia', name: 'Kia' };

export const MODELS: Record<string, Ref> = {
  cobalt: {
    id: 'cobalt',
    name: 'Cobalt',
    makeId: 'chevrolet',
    make: CHEVROLET,
  },
  gentra: {
    id: 'gentra',
    name: 'Gentra',
    makeId: 'chevrolet',
    make: CHEVROLET,
  },
  spark: { id: 'spark', name: 'Spark', makeId: 'chevrolet', make: CHEVROLET },
  'nexia-2': {
    id: 'nexia-2',
    name: 'Nexia 2',
    makeId: 'chevrolet',
    make: CHEVROLET,
  },
  'nexia-3': {
    id: 'nexia-3',
    name: 'Nexia 3',
    makeId: 'chevrolet',
    make: CHEVROLET,
  },
  'kia-rio': { id: 'kia-rio', name: 'Rio', makeId: 'kia', make: KIA },
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** A legacy (seller/import-projected) per-model fit row. */
const legacyFit = (make: string, model: string) => ({
  makeSlug: `make_${slug(make)}`,
  makeName: make,
  modelSlug: `model_${slug(make)}_${slug(model)}`,
  modelName: model,
});

interface PartSpec {
  id: string;
  isUniversal?: boolean;
  curated?: string[]; // VehicleModelRef ids
  fits?: [string, string][]; // [make, model] legacy rows
  makeFits?: string[]; // legacy make-wide make names
  compat?: { trimId: string | null; engineId: string | null; status: string }[];
  /** The dealer storefront's DealerStatus (default PENDING, like projections). */
  sellerStatus?: string;
}

export function part(spec: PartSpec) {
  return {
    id: spec.id,
    isUniversal: spec.isUniversal ?? false,
    fitmentBindings: (spec.curated ?? []).map((m) => ({
      vehicleModelId: m,
      vehicleModel: MODELS[m],
    })),
    fits: (spec.fits ?? []).map(([mk, md]) => legacyFit(mk, md)),
    makeFits: (spec.makeFits ?? []).map((mk) => ({
      makeSlug: `make_${slug(mk)}`,
      makeName: mk,
    })),
    compatibilities: (spec.compat ?? []).map((c) => ({ ...c, years: [] })),
    seller: { status: spec.sellerStatus ?? 'PENDING' },
  };
}

/** The catalogue every compatibility test runs against. */
export const PARTS = [
  part({ id: 'curated_cobalt', curated: ['cobalt'] }),
  part({ id: 'curated_spark', curated: ['spark'] }),
  part({ id: 'curated_multi', curated: ['cobalt', 'gentra', 'nexia-3'] }),
  part({ id: 'curated_nexia2', curated: ['nexia-2'] }),
  part({ id: 'curated_nexia3', curated: ['nexia-3'] }),
  // Seller said "Cobalt" but the operator curated it to Spark: curation wins.
  part({
    id: 'curated_overrides_legacy',
    curated: ['spark'],
    fits: [['Chevrolet', 'Cobalt']],
  }),
  // Imported as Chevrolet-wide, then curated to Gentra only: curation wins.
  part({
    id: 'curated_overrides_makewide',
    curated: ['gentra'],
    makeFits: ['Chevrolet'],
  }),
  part({ id: 'legacy_spark', fits: [['Chevrolet', 'Spark']] }),
  part({ id: 'legacy_cobalt', fits: [['Chevrolet', 'Cobalt']] }),
  part({ id: 'legacy_nexia3', fits: [['Chevrolet', 'Nexia 3']] }),
  part({ id: 'makewide_chevrolet', makeFits: ['Chevrolet'] }),
  part({ id: 'universal_oil', isUniversal: true }),
  part({
    id: 'trim_t_cobalt',
    compat: [{ trimId: 't_cobalt', engineId: null, status: 'FITS' }],
  }),
  part({ id: 'no_fitment' }),
];

const vehicle = (
  modelId: string,
  trimId: string | null = null,
): VehicleFitContext => ({
  modelId,
  makeName: MODELS[modelId].make.name,
  modelName: MODELS[modelId].name,
  trimId,
  engineId: null,
  year: 2022,
});

export const VEHICLES = {
  cobalt: vehicle('cobalt', 't_cobalt'),
  gentra: vehicle('gentra'),
  spark: vehicle('spark'),
  nexia2: vehicle('nexia-2'),
  nexia3: vehicle('nexia-3'),
  rio: vehicle('kia-rio'),
};

export type VehicleKey = keyof typeof VEHICLES;

/** Garage `Vehicle` rows as Prisma returns them with VEHICLE_FIT_SELECT. */
export function vehicleRow(v: VehicleFitContext) {
  return {
    modelId: v.modelId,
    trimId: v.trimId,
    engineId: v.engineId,
    year: v.year,
    make: { name: v.makeName },
    model: { name: v.modelName },
  };
}
