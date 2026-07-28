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
   * The listing fits a SPECIFIC set of vehicles, so its questionnaire asks for
   * them and its fitment is persisted as part_models rows. False means the kind
   * fits everything by definition (see `isUniversalKind`).
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
}

/** A draft/product field a kind may require. Names match the Prisma columns. */
export type KindRequiredField =
  'brand' | 'model' | 'category' | 'oilViscosity' | 'oilType' | 'oilVolumeMl';

export const KIND_CAPABILITIES: Record<ProductKind, KindCapabilities> = {
  [ProductKind.SPARE_PART]: {
    hasVehicleFitment: true,
    hasPartNumbers: true,
    hasVehicleCategory: true,
    requiredFields: ['brand', 'model', 'category'],
  },
  [ProductKind.MOTOR_OIL]: {
    // A motor oil fits every car, so it has no fitment to collect, no part
    // number to label, and no vehicle category to choose — its taxonomy follows
    // from being an oil.
    hasVehicleFitment: false,
    hasPartNumbers: false,
    hasVehicleCategory: false,
    requiredFields: ['oilViscosity', 'oilType', 'oilVolumeMl'],
  },
};

/** The capability record for a kind. */
export function capabilitiesOf(kind: ProductKind): KindCapabilities {
  return KIND_CAPABILITIES[kind];
}

/**
 * Whether products of this kind fit EVERY vehicle by design — the value written
 * to `Product.isUniversal` and projected into the buyer catalog.
 *
 * Defined as the exact complement of `hasVehicleFitment` rather than as its own
 * list, so the two can never disagree: a kind that collects no fitment IS
 * universal, and a kind that collects fitment is not.
 */
export function isUniversalKind(kind: ProductKind): boolean {
  return !capabilitiesOf(kind).hasVehicleFitment;
}

/**
 * Whether "does this fit my car?" is a meaningful question for this kind. A
 * universal kind carries no compatibility rows, so a generic compatibility check
 * would answer "maybe" — actively misleading for a product that always fits.
 */
export function hasCompatibility(kind: ProductKind): boolean {
  return capabilitiesOf(kind).hasVehicleFitment;
}

/** Whether this kind has GM / OEM part numbers at all. */
export function hasPartNumbers(kind: ProductKind): boolean {
  return capabilitiesOf(kind).hasPartNumbers;
}

/** Whether the seller picks a PartVehicleCategory for this kind. */
export function hasVehicleCategory(kind: ProductKind): boolean {
  return capabilitiesOf(kind).hasVehicleCategory;
}
