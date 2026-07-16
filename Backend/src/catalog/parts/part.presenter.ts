import { Prisma, CompatibilityStatus } from '@prisma/client';

export const PART_INCLUDE = {
  brand: true,
  category: true,
  seller: true,
  compatibilities: true,
  fits: true,
} satisfies Prisma.CatalogPartInclude;

export type PartWithRelations = Prisma.CatalogPartGetPayload<{ include: typeof PART_INCLUDE }>;

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
    return { status: trimMatch.status.toLowerCase(), confidence: Number(trimMatch.confidence), notes: null };
  }

  const engineMatch = compatibilities.find((c) => c.engineId && c.engineId === vehicle.engineId);
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

/** Map a CatalogPart row to the contract's list-item shape. */
export function presentPartItem(part: PartWithRelations, vehicle: VehicleCompatContext | null) {
  return {
    id: part.id,
    title: part.title,
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
    // 'GM' | 'OEM' | 'UNKNOWN' — never guessed; UNKNOWN means the seller left the
    // number unlabeled and it is intentionally searchable as both.
    part_number_type: part.partNumberType,
    price_uzs: Number(part.priceUzs),
    price_label: formatUzs(part.priceUzs),
    currency: part.currency,
    in_stock: part.inStock,
    delivery_eta_days_min: part.deliveryEtaDaysMin,
    delivery_eta_days_max: part.deliveryEtaDaysMax,
    compatibility: computeCompatibility(part.compatibilities, vehicle),
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
    seller: { id: part.seller.id, name: part.seller.name, rating_avg: Number(part.seller.ratingAvg) },
  };
}
