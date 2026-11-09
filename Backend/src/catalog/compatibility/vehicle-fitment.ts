import { Prisma } from '@prisma/client';

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
}

/** The Vehicle columns every compatibility lookup selects. */
export const VEHICLE_FIT_SELECT = {
  modelId: true,
  trimId: true,
  engineId: true,
  year: true,
  make: { select: { name: true } },
  model: { select: { name: true } },
} satisfies Prisma.VehicleSelect;

export type VehicleFitRow = Prisma.VehicleGetPayload<{
  select: typeof VEHICLE_FIT_SELECT;
}>;

export function toVehicleFitContext(v: VehicleFitRow): VehicleFitContext {
  return {
    modelId: v.modelId,
    makeName: v.make?.name ?? null,
    modelName: v.model?.name ?? null,
    trimId: v.trimId,
    engineId: v.engineId,
    year: v.year,
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

  if (v.modelId) {
    or.push({ fitmentBindings: { some: { vehicleModelId: v.modelId } } });
  }

  const legacy: Prisma.CatalogPartWhereInput[] = [];
  if (v.makeName && v.modelName) {
    legacy.push({
      fits: {
        some: {
          AND: [
            { makeName: sameName(v.makeName) },
            { modelName: sameName(v.modelName) },
          ],
        },
      },
    });
  }
  if (v.makeName) {
    legacy.push({ makeFits: { some: { makeName: sameName(v.makeName) } } });
  }
  if (legacy.length > 0) {
    or.push({ AND: [HAS_NO_CURATED_FITMENT, { OR: legacy }] });
  }

  if (v.trimId || v.engineId) {
    const compatOr: Prisma.PartCompatibilityWhereInput[] = [];
    if (v.trimId) compatOr.push({ trimId: v.trimId });
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
    ? {
        trimId: v.trimId,
        OR: [{ years: { isEmpty: true } }, { years: { has: v.year } }],
      }
    : null;
  const engineRow: Prisma.PartCompatibilityWhereInput | null = v.engineId
    ? { engineId: v.engineId }
    : null;
  const curated: Prisma.CatalogPartWhereInput | null = v.modelId
    ? { fitmentBindings: { some: { vehicleModelId: v.modelId } } }
    : null;
  const notTrim: Prisma.CatalogPartWhereInput[] = trimRow
    ? [{ compatibilities: { none: trimRow } }]
    : [];
  const notCurated: Prisma.CatalogPartWhereInput[] = v.modelId
    ? [{ fitmentBindings: { none: { vehicleModelId: v.modelId } } }]
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
