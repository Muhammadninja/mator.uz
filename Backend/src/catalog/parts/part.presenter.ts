import { Prisma, CompatibilityStatus, ProductKind } from '@prisma/client';
import { OIL_TYPE_LABELS, formatVolume } from '../../common/motor-oil.util';

export const PART_INCLUDE = {
  brand: true,
  category: true,
  seller: true,
  compatibilities: true,
  fits: true,
} satisfies Prisma.CatalogPartInclude;

export type PartWithRelations = Prisma.CatalogPartGetPayload<{
  include: typeof PART_INCLUDE;
}>;

export interface VehicleCompatContext {
  trimId: string | null;
  engineId: string | null;
  year: number;
}

export interface CompatibilityResult {
  status: string; // fits | maybe | does_not_fit
  confidence: number;
  notes: string | null;
}

/** Format an integer-UZS amount as "UZS 185 000" (space thousands separator). */
export function formatUzs(amount: Prisma.Decimal | number): string {
  const n = Math.round(Number(amount));
  return `UZS ${n.toLocaleString('en-US').replace(/,/g, ' ')}`;
}

/**
 * Project a part's stored compatibility rows onto a specific vehicle.
 * Trim+year match is strongest; engine match is next; an explicit miss is
 * "does_not_fit"; absence of data is "maybe".
 */
export function computeCompatibility(
  compatibilities: PartWithRelations['compatibilities'],
  vehicle: VehicleCompatContext | null,
): CompatibilityResult | null {
  if (!vehicle) return null;

  const trimMatch = compatibilities.find(
    (c) =>
      c.trimId &&
      c.trimId === vehicle.trimId &&
      (c.years.length === 0 || c.years.includes(vehicle.year)),
  );
  if (trimMatch) {
    return {
      status: trimMatch.status.toLowerCase(),
      confidence: Number(trimMatch.confidence),
      notes: null,
    };
  }

  const engineMatch = compatibilities.find(
    (c) => c.engineId && c.engineId === vehicle.engineId,
  );
  if (engineMatch) {
    return {
      status: (engineMatch.status === CompatibilityStatus.FITS
        ? CompatibilityStatus.MAYBE
        : engineMatch.status
      ).toLowerCase(),
      confidence: Number(engineMatch.confidence),
      notes: null,
    };
  }

  if (compatibilities.length > 0) {
    return { status: 'does_not_fit', confidence: 1, notes: null };
  }
  return { status: 'maybe', confidence: 0, notes: null };
}

/**
 * The attributes peculiar to a part's KIND, or null when the kind has none of
 * its own. Nested under one key rather than spread across the item so a client
 * can switch on `kind` and read one object, and so a future kind adds a branch
 * here without widening every part's payload with more always-null fields.
 *
 * Each value is returned both raw (for filtering/sorting) and as a display label
 * (`*_label`), matching how `price_uzs` / `price_label` already pair up.
 */
/**
 * Whether a listing's KIND has a part-number concept (GM / OEM). Spare parts do;
 * motor oils do not — their questionnaire never asks for one, so the columns are
 * empty by construction rather than by omission.
 */
function hasPartNumbers(part: PartWithRelations): boolean {
  return part.kind !== ProductKind.MOTOR_OIL;
}

/**
 * Whether a listing's KIND has a vehicle-compatibility concept. Motor oils are
 * universal by design (see isUniversalKind in the wizard), so asking "does this
 * fit your car" is not a question with a meaningful answer for them.
 */
function hasCompatibility(part: PartWithRelations): boolean {
  return part.kind !== ProductKind.MOTOR_OIL;
}

function presentKindAttributes(part: PartWithRelations) {
  if (part.kind !== ProductKind.MOTOR_OIL) return null;
  return {
    viscosity: part.oilViscosity,
    oil_type: part.oilType,
    oil_type_label: part.oilType ? OIL_TYPE_LABELS[part.oilType] : null,
    volume_ml: part.oilVolumeMl,
    volume_label:
      part.oilVolumeMl !== null ? formatVolume(part.oilVolumeMl) : null,
  };
}

/** Map a CatalogPart row to the contract's list-item shape. */
export function presentPartItem(
  part: PartWithRelations,
  vehicle: VehicleCompatContext | null,
) {
  return {
    id: part.id,
    title: part.title,
    // What this listing IS ('SPARE_PART' | 'MOTOR_OIL'). Drives which card the
    // client renders; `motor_oil` below carries the oil-specific attributes.
    kind: part.kind,
    motor_oil: presentKindAttributes(part),
    brand: part.brand ? { id: part.brand.id, name: part.brand.name } : null,
    category: { id: part.category.id, name: part.category.name },
    // Classified taxonomy + attributes (enum values; null until classified).
    main_category: part.mainCategory,
    vehicle_category: part.vehicleCategory,
    part_brand_name: part.partBrandName,
    origin_region: part.originRegion,
    is_oem: part.isOem,
    is_gm: part.isGm,
    is_universal: part.isUniversal,
    oem_numbers: part.oemNumbers,
    gm_numbers: part.gmNumbers,
    // 'GM' | 'OEM' | 'UNKNOWN' for a spare part — never guessed; UNKNOWN means
    // the seller left the number unlabeled and it is intentionally searchable as
    // both. NULL for a kind that has no part-number concept at all (motor oils):
    // "UNKNOWN" there would read as "we don't know this oil's number", inviting a
    // UI to render an empty "OEM/GM №" row for a product that can never have one.
    part_number_type: hasPartNumbers(part) ? part.partNumberType : null,
    price_uzs: Number(part.priceUzs),
    price_label: formatUzs(part.priceUzs),
    currency: part.currency,
    in_stock: part.inStock,
    delivery_eta_days_min: part.deliveryEtaDaysMin,
    delivery_eta_days_max: part.deliveryEtaDaysMax,
    // Null for a kind with no compatibility concept. Without this a motor oil
    // reported {status:'maybe'} — actively WRONG, since "maybe" tells the buyer
    // it might not fit their car, when an oil fits every car by definition.
    compatibility: hasCompatibility(part)
      ? computeCompatibility(part.compatibilities, vehicle)
      : null,
    // Static make/model fitment for this part, projected from the supply-side
    // PartModel links into catalog_part_fits. Purely additive surfacing of data
    // that already exists — lets the buyer show "Fits: Chevrolet Cobalt, …"
    // without a per-vehicle compatibility check. Sorted by model slug for a
    // stable order. Empty for universal parts (they carry no fit rows).
    fits: [...part.fits]
      .sort((a, b) => a.modelSlug.localeCompare(b.modelSlug))
      .map((f) => ({
        make_slug: f.makeSlug,
        make_name: f.makeName,
        model_slug: f.modelSlug,
        model_name: f.modelName,
      })),
    images: part.images,
    // `certified` is the "MATOR Certified" dealer badge (CatalogSeller.certified,
    // maintained by the admin dealer console). Non-null by schema default, so
    // every seller — curated or projected — reports a real boolean, never null.
    seller: {
      id: part.seller.id,
      name: part.seller.name,
      rating_avg: Number(part.seller.ratingAvg),
      certified: part.seller.certified,
    },
  };
}
