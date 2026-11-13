import { Prisma } from '@prisma/client';
import { resolveGeneration } from '../../garage/vehicles/vehicle-generation';

/**
 * The ONE buyer-facing compatibility decision path, shared by the parts listing
 * (GET /v1/catalog/parts?vehicle_id=), the category counts and the per-part
 * compatibility checks, so the three can never disagree about which parts fit
 * a garage vehicle.
 *
 * ── Sources, in the order they are trusted ──────────────────────────────────
 *   1. UNIVERSAL (`CatalogPart.isUniversal`) — fits every vehicle.
 *   2. CURATED model fitment (`fitment_bindings`), written by the admin Fitment
 *      Studio. Matched on the STABLE reference id: garage `Vehicle.modelId` ===
 *      `FitmentBinding.vehicleModelId`. Nexia 2 and Nexia 3 are two
 *      VehicleModelRef rows, so a binding to one never reaches the other.
 *   3. LEGACY seller/import fitment (`catalog_part_fits` per model,
 *      `catalog_part_make_fits` per make), projected from names the seller bot
 *      and the dealer import stored. They carry no reference ids, so they are
 *      matched on canonical names — and a per-model row needs BOTH its make and
 *      its model to match. (The previous `model OR make` test let a Cobalt see
 *      every Chevrolet part.) A make-wide row matches on the make alone, which
 *      is exactly what make-wide means.
 *   4. TRIM/ENGINE rows (`part_compatibilities`) — unchanged.
 *
 * ── Resolved generation (Wave 3) ────────────────────────────────────────────
 * A generic model (`nexia`) can have hidden generation rows (`nexia-1/2/3`,
 * `variant_of_model_id`), and parts are often filed under those rows: by id in
 * curated bindings, by name ("Nexia 3") in legacy rows. When the Garage
 * vehicle's generation is RESOLVED by `resolveGeneration` (its year falls in
 * exactly one generation's verified range, or the owner picked one), the
 * vehicle also matches bindings to that generation's id and legacy rows under
 * that generation's name. Nothing else: an unresolved or ambiguous vehicle
 * (no year match, a year two generations share without a pick) gets no
 * generation parts. A picked trim names its generation only through the
 * explicit TRIM_GENERATION_PREFIXES list (`nexia-3-*` → Nexia 3) and only when
 * the year agrees; otherwise it names none. One generation never sees
 * another's parts, and a vehicle without a resolved generation produces exactly
 * the predicates it did before.
 *
 * ── Curation is authoritative ───────────────────────────────────────────────
 * A part that has ANY curated binding is decided by its bindings alone; its
 * legacy name-based rows (per-model and make-wide) are ignored. Otherwise an
 * operator removing Spark from a part would change nothing for Spark owners,
 * because the seller's original "Spark" row would still match — and an
 * explicitly curated model list would quietly widen back to the whole make.
 * Universal parts and trim/engine rows are not affected by this rule.
 */

/** Garage-vehicle facts a compatibility decision needs. */
export interface VehicleFitContext {
  /** VehicleModelRef id — the key curated fitment is stored under. */
  modelId: string | null;
  /** Canonical names, used ONLY for the legacy name-based rows. */
  makeName: string | null;
  modelName: string | null;
  trimId: string | null;
  engineId: string | null;
  year: number;
  /** The resolved generation row (`nexia-3`), only when unambiguous. */
  generationModelId?: string;
  /** Its canonical name ("Nexia 3"), for the legacy name-based rows. */
  generationModelName?: string;
}

/** The Vehicle columns every compatibility lookup selects. */
export const VEHICLE_FIT_SELECT = {
  modelId: true,
  trimId: true,
  engineId: true,
  year: true,
  variantModelId: true,
  make: { select: { name: true } },
  model: {
    select: {
      name: true,
      // Hidden generation rows of this model, for resolveGeneration.
      variants: {
        select: {
          id: true,
          makeId: true,
          name: true,
          bodyType: true,
          yearFrom: true,
          yearTo: true,
        },
      },
    },
  },
} satisfies Prisma.VehicleSelect;

export type VehicleFitRow = Prisma.VehicleGetPayload<{
  select: typeof VEHICLE_FIT_SELECT;
}>;

/**
 * Trims that name their generation, per generic model: a trim id starting with
 * the prefix belongs to that generation row. Explicit, owner-confirmed pairs
 * only (2026-11-13); nothing is inferred from other trim ids or names.
 */
export const TRIM_GENERATION_PREFIXES: Readonly<
  Record<string, ReadonlyArray<{ prefix: string; generationId: string }>>
> = {
  nexia: [
    { prefix: 'nexia-1-', generationId: 'nexia-1' },
    { prefix: 'nexia-2-', generationId: 'nexia-2' },
    { prefix: 'nexia-3-', generationId: 'nexia-3' },
  ],
};

type VariantRow = NonNullable<VehicleFitRow['model']>['variants'][number];

/**
 * The generation a picked trim names, when it is unambiguous AND consistent:
 * the trim matches exactly one listed prefix of the vehicle's own model, that
 * generation row exists, and its verified years hold the vehicle year. A trim
 * that contradicts the year (a `nexia-3-*` trim on a 2010 car) names nothing.
 */
export function generationFromTrim(
  modelId: string | null,
  trimId: string | null,
  year: number,
  variants: readonly VariantRow[],
): VariantRow | null {
  if (!modelId || !trimId) return null;
  const hits = (TRIM_GENERATION_PREFIXES[modelId] ?? []).filter((p) =>
    trimId.startsWith(p.prefix),
  );
  if (hits.length !== 1) return null;
  const row = variants.find((r) => r.id === hits[0].generationId);
  if (!row || row.yearFrom == null || row.yearTo == null) return null;
  return year >= row.yearFrom && year <= row.yearTo ? row : null;
}

export function toVehicleFitContext(v: VehicleFitRow): VehicleFitContext {
  // `?? []`: rows read without the relation (older callers, mocks) resolve nothing.
  const variants = v.model?.variants ?? [];
  const resolution = resolveGeneration({
    year: v.year,
    trimId: v.trimId,
    variants,
    chosenVariantId: v.variantModelId ?? null,
  });
  // resolveGeneration answers nothing once a trim is picked (it never reads trim
  // ids); for fitment the trim itself can name the generation.
  const generation =
    resolution?.status === 'resolved'
      ? resolution.variant
      : generationFromTrim(v.modelId, v.trimId, v.year, variants);
  return {
    modelId: v.modelId,
    makeName: v.make?.name ?? null,
    modelName: v.model?.name ?? null,
    trimId: v.trimId,
    engineId: v.engineId,
    year: v.year,
    ...(generation
      ? {
          generationModelId: generation.id,
          generationModelName: generation.name,
        }
      : {}),
  };
}

/**
 * The model ids whose curated bindings reach this vehicle: its own model, plus
 * its resolved generation row. Empty when the vehicle has no model.
 */
export function fitModelIds(v: {
  modelId?: string | null;
  generationModelId?: string;
}): string[] {
  if (!v.modelId) return [];
  return v.generationModelId ? [v.modelId, v.generationModelId] : [v.modelId];
}

/** Bindings to any of `ids`; the single-id shape when there is one (unchanged predicates). */
const bindingTo = (ids: string[]): Prisma.FitmentBindingWhereInput =>
  ids.length === 1
    ? { vehicleModelId: ids[0] }
    : { vehicleModelId: { in: ids } };

/**
 * A trim compatibility row that applies to this model year: its `years` list
 * is empty (every year) or names the year. The single translation of the
 * card's `c.years.length === 0 || c.years.includes(year)`.
 */
export function trimRowForYear(
  trimId: string,
  year: number,
): Prisma.PartCompatibilityWhereInput {
  return {
    trimId,
    OR: [{ years: { isEmpty: true } }, { years: { has: year } }],
  };
}

/** Matches parts that carry NO curated binding (so legacy rows still decide). */
export const HAS_NO_CURATED_FITMENT = {
  fitmentBindings: { none: {} },
} satisfies Prisma.CatalogPartWhereInput;

const sameName = (value: string) => ({
  equals: value,
  mode: 'insensitive' as const,
});

/**
 * Restrict a catalog query to the parts that fit one garage vehicle. See the
 * file header for the decision order; this is its single Prisma translation.
 */
export function vehicleFitWhere(
  v: VehicleFitContext,
): Prisma.CatalogPartWhereInput {
  const or: Prisma.CatalogPartWhereInput[] = [{ isUniversal: true }];
  const modelIds = fitModelIds(v);

  if (modelIds.length > 0) {
    or.push({ fitmentBindings: { some: bindingTo(modelIds) } });
  }

  const legacy: Prisma.CatalogPartWhereInput[] = [];
  const legacyModelNames = [v.modelName, v.generationModelName].filter(
    (n): n is string => !!n,
  );
  if (v.makeName) {
    for (const modelName of legacyModelNames) {
      legacy.push({
        fits: {
          some: {
            AND: [
              { makeName: sameName(v.makeName) },
              { modelName: sameName(modelName) },
            ],
          },
        },
      });
    }
  }
  if (v.makeName) {
    legacy.push({ makeFits: { some: { makeName: sameName(v.makeName) } } });
  }
  if (legacy.length > 0) {
    or.push({ AND: [HAS_NO_CURATED_FITMENT, { OR: legacy }] });
  }

  if (v.trimId || v.engineId) {
    const compatOr: Prisma.PartCompatibilityWhereInput[] = [];
    // LOW-CAT-008: a trim row matches only within its model years, the rule
    // computeCompatibility (the card) and the compatibility facet already
    // apply: no years means every year. Engine rows carry no year rule in the
    // card, so none is added here either.
    if (v.trimId) compatOr.push(trimRowForYear(v.trimId, v.year));
    if (v.engineId) compatOr.push({ engineId: v.engineId });
    or.push({
      compatibilities: {
        some: { AND: [{ OR: compatOr }, { NOT: { status: 'DOES_NOT_FIT' } }] },
      },
    });
  }

  return { OR: or };
}

/**
 * The compatibility facet as two counts' worth of `where`, so the database does the
 * counting: the same decision computeCompatibility makes for one part, in its order.
 *   1. a trim row for this trim and year decides, with its own status;
 *   2. else a curated binding to this model is a fit;
 *   3. else an engine row decides, FITS read down to maybe;
 *   4. else any other fitment data at all means it does not fit;
 *   5. else it is a maybe, which is whatever the other two leave.
 */
export function compatibilityFacetWhere(v: VehicleFitContext): {
  fits: Prisma.CatalogPartWhereInput;
  doesNotFit: Prisma.CatalogPartWhereInput;
} {
  const trimRow: Prisma.PartCompatibilityWhereInput | null = v.trimId
    ? trimRowForYear(v.trimId, v.year)
    : null;
  const engineRow: Prisma.PartCompatibilityWhereInput | null = v.engineId
    ? { engineId: v.engineId }
    : null;
  const modelIds = fitModelIds(v);
  const curated: Prisma.CatalogPartWhereInput | null =
    modelIds.length > 0
      ? { fitmentBindings: { some: bindingTo(modelIds) } }
      : null;
  const notTrim: Prisma.CatalogPartWhereInput[] = trimRow
    ? [{ compatibilities: { none: trimRow } }]
    : [];
  const notCurated: Prisma.CatalogPartWhereInput[] =
    modelIds.length > 0
      ? [{ fitmentBindings: { none: bindingTo(modelIds) } }]
      : [];
  const notEngine: Prisma.CatalogPartWhereInput[] = engineRow
    ? [{ compatibilities: { none: engineRow } }]
    : [];

  const fits: Prisma.CatalogPartWhereInput[] = [];
  const doesNotFit: Prisma.CatalogPartWhereInput[] = [];
  if (trimRow) {
    fits.push({ compatibilities: { some: { AND: [trimRow, { status: 'FITS' }] } } });
    doesNotFit.push({
      compatibilities: { some: { AND: [trimRow, { status: 'DOES_NOT_FIT' }] } },
    });
  }
  if (curated) fits.push({ AND: [...notTrim, curated] });
  if (engineRow) {
    doesNotFit.push({
      AND: [
        ...notTrim,
        ...notCurated,
        { compatibilities: { some: { AND: [engineRow, { status: 'DOES_NOT_FIT' }] } } },
      ],
    });
  }
  doesNotFit.push({
    AND: [
      ...notTrim,
      ...notCurated,
      ...notEngine,
      { OR: [{ compatibilities: { some: {} } }, { fitmentBindings: { some: {} } }] },
    ],
  });
  return {
    fits: fits.length > 0 ? { OR: fits } : { id: { in: [] } },
    doesNotFit: { OR: doesNotFit },
  };
}
