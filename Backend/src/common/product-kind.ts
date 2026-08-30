// src/common/product-kind.ts
//
// THE SINGLE SOURCE OF TRUTH for what each ProductKind *is* — the capability
// table every layer consults instead of re-deriving behaviour from a kind check
// or, worse, from the product's own fields.
//
// It lives in common/ because the rules cross bounded contexts: the seller bot
// (wizard, draft coordinator, commit), the buyer catalog (filters, presenter),
// and the projection between them all gate on the same facts. Putting the table
// in either context would force the other to duplicate it — which is precisely
// the failure this module exists to prevent.
//
// ── Why a table and not scattered predicates ────────────────────────────────
// Two production bugs came from independently-maintained copies of these rules:
//   • DraftCoordinator kept its own "form complete" check demanding
//     brand+model+category. A motor oil has none of those by design, so a fully
//     answered oil never passed the rendezvous: no transition, no event, no
//     exception — the seller waited on "⏳ Завершаем обработку фото…" forever.
//   • The buyer card re-derived "has compatibility" locally and reported
//     {status:'maybe'} for oils — telling buyers an oil might not fit their car.
// Both were invisible to tests that asserted flow definitions rather than
// behaviour, and both would have recurred for the NEXT kind added.
//
// ── Adding a kind ───────────────────────────────────────────────────────────
// Add one entry below. `Record<ProductKind, KindCapabilities>` is exhaustive, so
// the compiler REFUSES to build until the new kind declares every capability —
// there is no silent default to fall through to. Everything downstream (draft
// completeness, universality, compatibility, part numbers, preview layout,
// vehicle links) then follows from this one entry.

import { ProductKind } from '@prisma/client';

/** What a kind of listing fundamentally is, and therefore how it behaves. */
export interface KindCapabilities {
  /**
   * The listing MAY fit a specific set of vehicles, so its questionnaire can ask
   * for them and its fitment is persisted as part_models rows. False means the
   * kind fits everything by definition and no vehicle is ever collected.
   *
   * NOTE this is a capability, NOT the per-listing answer. Whether one listing
   * is universal is a property of that listing's own data (did the seller pick a
   * vehicle?), and lives in `Product.isUniversal` — see {@link isUniversalFor}.
   * MOTOR_OIL is the case that forced the distinction: an oil sold FOR a
   * Chevrolet Cobalt is vehicle-specific, while an oil listed under "Другое"
   * fits everything, and both are the same kind.
   */
  readonly hasVehicleFitment: boolean;
  /**
   * The listing has GM / OEM part numbers. False means the concept does not
   * apply — the columns are empty by construction, not by omission, so a UI must
   * not render an "OEM/GM №" row for it.
   */
  readonly hasPartNumbers: boolean;
  /**
   * The listing belongs to a vehicle-part category (PartVehicleCategory) chosen
   * by the seller. False means the taxonomy is implied by the kind itself.
   */
  readonly hasVehicleCategory: boolean;
  /**
   * The attribute columns this kind REQUIRES before it can be previewed and
   * committed — the fields its questionnaire is responsible for filling. Title
   * and price are required by every kind and are checked separately.
   */
  readonly requiredFields: readonly KindRequiredField[];
  /**
   * The UNIT a listing of this kind is quantified in. A property of the KIND,
   * never a stored column and never a per-listing choice: antifreeze is sold by
   * the kilogram whatever the seller does, exactly as a brake pad is sold by the
   * piece. Stating it here is what keeps a "шт" from ever being rendered — or
   * fiscalized — for a kind that is not sold by the piece.
   *
   * NOT the Tasnif package code. That code is the fiscal unit-of-sale and still
   * comes from the category (or, for oil, from the oil type); this is the unit
   * the human-facing surfaces show.
   */
  readonly unit: ProductUnit;
  /**
   * The listing's MXIK / package code come from its OIL TYPE rather than from
   * its category — true only for motor oil, whose registry classification is by
   * base composition (see OIL_TYPE_FISCAL in common/fiscal.util.ts).
   *
   * Every other kind fiscalizes from the category it was filed under, which is
   * what keeps antifreeze on its own IKPU instead of borrowing an oil's.
   */
  readonly fiscalizedByOilType: boolean;
}

/**
 * How a listing of a given kind is quantified: by the piece, by volume, or by
 * weight. Closed set — a kind names one of these, and every surface (bot
 * preview, buyer card) renders that unit instead of assuming "шт".
 */
export type ProductUnit = 'PCS' | 'L' | 'KG';

/** A draft/product field a kind may require. Names match the Prisma columns. */
export type KindRequiredField =
  | 'brand'
  | 'model'
  | 'categoryId'
  | 'oilViscosity'
  | 'oilType'
  | 'oilVolumeMl'
  | 'antifreezeWeightG';

export const KIND_CAPABILITIES: Record<ProductKind, KindCapabilities> = {
  [ProductKind.SPARE_PART]: {
    hasVehicleFitment: true,
    hasPartNumbers: true,
    hasVehicleCategory: true,
    // `categoryId` (the dynamic tree node), NOT the legacy `category` enum: an
    // admin-created category mirrors no enum, so requiring the enum would make a
    // fully-answered draft look incomplete.
    requiredFields: ['brand', 'model', 'categoryId'],
    unit: 'PCS',
    fiscalizedByOilType: false,
  },
  [ProductKind.MOTOR_OIL]: {
    // An oil MAY be sold for a specific car ("масло для Cobalt") or as a general
    // product listed under "Другое". So it CAN carry fitment — but never
    // requires it, which is why brand/model are absent from requiredFields
    // below. `isUniversal` is decided per listing from whether a vehicle was
    // actually chosen, not from this flag.
    hasVehicleFitment: true,
    // Still no part number and no vehicle-part category question: those follow
    // from being an oil regardless of which vehicle it targets.
    hasPartNumbers: false,
    hasVehicleCategory: false,
    requiredFields: ['oilViscosity', 'oilType', 'oilVolumeMl'],
    // An oil is quoted by volume; its packaged size is oilVolumeMl.
    unit: 'L',
    // The registry issues one MXIK per BASE COMPOSITION, so the codes come from
    // the seller's OIL_TYPE answer and never from the category.
    fiscalizedByOilType: true,
  },
  [ProductKind.ANTIFREEZE]: {
    // Reached only through the "Другое" branch ("Что продаёте?" → Антифриз),
    // where no vehicle is ever asked — so an antifreeze listing fits everything
    // by construction, exactly like a kind that cannot carry fitment at all.
    hasVehicleFitment: false,
    hasPartNumbers: false,
    // Its taxonomy follows from the kind: the listing is filed under the
    // existing `antifreeze` category, so the seller is never asked to pick one.
    hasVehicleCategory: false,
    requiredFields: ['antifreezeWeightG'],
    // THE POINT OF THE KIND: antifreeze is sold by WEIGHT. Nothing may render or
    // fiscalize it as "шт" — the questionnaire collects kilograms (stored as
    // grams) and every surface reads the unit from here.
    unit: 'KG',
    // Antifreeze keeps its OWN category's IKPU / package code. It must never
    // fall onto the oil table, whose three codes describe motor oil only.
    fiscalizedByOilType: false,
  },
};

/** The capability record for a kind. */
export function capabilitiesOf(kind: ProductKind): KindCapabilities {
  return KIND_CAPABILITIES[kind];
}

/**
 * Whether ONE listing fits every vehicle — the value written to
 * `Product.isUniversal` and projected into the buyer catalog.
 *
 * This is a property of the LISTING, not of its kind. A kind that can never
 * carry fitment (hasVehicleFitment: false) is universal by construction; for
 * every other kind the answer is "did the seller actually name a vehicle?".
 *
 * That distinction is the whole point: a motor oil sold FOR a Chevrolet Cobalt
 * must NOT be universal just because it is an oil, while an oil listed under
 * "Другое" — where no vehicle is ever asked — must be. Deriving this from the
 * kind alone is exactly the bug this replaces.
 */
export function isUniversalFor(
  kind: ProductKind,
  vehicle: { brand: string | null; model: string | null },
): boolean {
  if (!capabilitiesOf(kind).hasVehicleFitment) return true;
  return vehicle.brand === null || vehicle.model === null;
}

/**
 * Whether "does this fit my car?" is a meaningful question for this LISTING.
 *
 * A universal listing carries no compatibility rows, so a generic check would
 * answer "maybe" — actively misleading for a product that always fits. A
 * vehicle-specific listing (including an oil sold for one car) does have a
 * meaningful answer, so it must not be suppressed.
 */
export function hasCompatibility(
  kind: ProductKind,
  isUniversal: boolean,
): boolean {
  return capabilitiesOf(kind).hasVehicleFitment && !isUniversal;
}

/** Whether this kind has GM / OEM part numbers at all. */
export function hasPartNumbers(kind: ProductKind): boolean {
  return capabilitiesOf(kind).hasPartNumbers;
}

/** Whether the seller picks a PartVehicleCategory for this kind. */
export function hasVehicleCategory(kind: ProductKind): boolean {
  return capabilitiesOf(kind).hasVehicleCategory;
}

/** The unit a listing of this kind is quantified in ('PCS' | 'L' | 'KG'). */
export function unitOf(kind: ProductKind): ProductUnit {
  return capabilitiesOf(kind).unit;
}

/**
 * Whether this kind's fiscal codes come from its OIL TYPE instead of its
 * category. Read by the Payme receipt builder, so the rule lives with the rest
 * of the kind's facts rather than as a `kind === MOTOR_OIL` check on the wire.
 */
export function fiscalizedByOilType(kind: ProductKind): boolean {
  return capabilitiesOf(kind).fiscalizedByOilType;
}
