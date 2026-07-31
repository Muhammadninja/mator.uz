// Tests for the ProductKind capability table — the single source of truth every
// layer consults instead of re-deriving per-kind behaviour.
//
// The most valuable test here is the LAST one: it enumerates ProductKind at
// runtime and fails the moment a kind is added without a capability entry. That
// is the guard against the class of bug that produced this module — a new kind
// silently inheriting some other kind's rules in one layer while another layer
// disagreed.

import { ProductKind } from '@prisma/client';
import {
  KIND_CAPABILITIES,
  capabilitiesOf,
  hasCompatibility,
  hasPartNumbers,
  hasVehicleCategory,
  isUniversalFor,
} from './product-kind';

describe('ProductKind capability table', () => {
  it('describes a spare part as vehicle-specific with part numbers', () => {
    expect(capabilitiesOf(ProductKind.SPARE_PART)).toEqual({
      hasVehicleFitment: true,
      hasPartNumbers: true,
      hasVehicleCategory: true,
      requiredFields: ['brand', 'model', 'categoryId'],
    });
  });

  it('describes a motor oil as OPTIONALLY vehicle-specific, with no part numbers', () => {
    expect(capabilitiesOf(ProductKind.MOTOR_OIL)).toEqual({
      // An oil MAY be sold for a specific car, so it CAN carry fitment — but
      // never requires it (brand/model are absent from requiredFields).
      hasVehicleFitment: true,
      hasPartNumbers: false,
      hasVehicleCategory: false,
      requiredFields: ['oilViscosity', 'oilType', 'oilVolumeMl'],
    });
  });
});

describe('derived predicates stay consistent with the table', () => {
  it('a kind that can never carry fitment is universal whatever its data', () => {
    for (const kind of Object.values(ProductKind)) {
      if (capabilitiesOf(kind).hasVehicleFitment) continue;
      expect(
        isUniversalFor(kind, { brand: 'Chevrolet', model: 'Cobalt' }),
      ).toBe(true);
    }
  });

  it('for a fitment-capable kind, universality follows the LISTING', () => {
    // The rule that replaced "universal by kind": the same kind is universal or
    // not depending on whether the seller actually named a vehicle.
    for (const kind of Object.values(ProductKind)) {
      if (!capabilitiesOf(kind).hasVehicleFitment) continue;
      expect(isUniversalFor(kind, { brand: null, model: null })).toBe(true);
      expect(
        isUniversalFor(kind, { brand: 'Chevrolet', model: 'Cobalt' }),
      ).toBe(false);
    }
  });

  it('a universal listing never has compatibility, and vice versa', () => {
    for (const kind of Object.values(ProductKind)) {
      for (const isUniversal of [true, false]) {
        if (!capabilitiesOf(kind).hasVehicleFitment) continue;
        expect(hasCompatibility(kind, isUniversal)).toBe(!isUniversal);
      }
    }
  });

  it('answers the concrete cases the product relies on', () => {
    const noVehicle = { brand: null, model: null };
    const cobalt = { brand: 'Chevrolet', model: 'Cobalt' };
    // A "Другое" oil is universal; an oil sold FOR a car is not.
    expect(isUniversalFor(ProductKind.MOTOR_OIL, noVehicle)).toBe(true);
    expect(isUniversalFor(ProductKind.MOTOR_OIL, cobalt)).toBe(false);
    expect(isUniversalFor(ProductKind.SPARE_PART, cobalt)).toBe(false);
    // A universal oil has no compatibility question; a vehicle-specific one does.
    expect(hasCompatibility(ProductKind.MOTOR_OIL, true)).toBe(false);
    expect(hasCompatibility(ProductKind.MOTOR_OIL, false)).toBe(true);
    expect(hasPartNumbers(ProductKind.MOTOR_OIL)).toBe(false);
    expect(hasPartNumbers(ProductKind.SPARE_PART)).toBe(true);
    expect(hasVehicleCategory(ProductKind.MOTOR_OIL)).toBe(false);
  });
});

describe('the table covers every ProductKind (future-kind guard)', () => {
  it('has an entry for every enum member', () => {
    // Runtime enumeration, not a hardcoded list: adding MOTOR_OIL_2 to the enum
    // fails HERE until its capabilities are declared, instead of silently
    // reaching production with undefined behaviour in five separate layers.
    for (const kind of Object.values(ProductKind)) {
      expect(KIND_CAPABILITIES[kind]).toBeDefined();
      expect(capabilitiesOf(kind)).toBeDefined();
    }
    expect(Object.keys(KIND_CAPABILITIES).sort()).toEqual(
      Object.values(ProductKind).sort(),
    );
  });

  it('every kind declares at least one required field', () => {
    // A kind whose questionnaire requires nothing would pass the completeness
    // gate on title+price alone — almost certainly a forgotten entry.
    for (const kind of Object.values(ProductKind)) {
      expect(capabilitiesOf(kind).requiredFields.length).toBeGreaterThan(0);
    }
  });

  it('brand and model are required together, or not at all', () => {
    // persistVehicleLinks skips a pair with no brand, and isUniversalFor treats a
    // half-answered vehicle as universal, so requiring one without the other
    // would be silently meaningless.
    for (const kind of Object.values(ProductKind)) {
      const required = capabilitiesOf(kind).requiredFields;
      expect(required.includes('brand')).toBe(required.includes('model'));
    }
  });

  it('a kind that requires a vehicle must be able to carry fitment', () => {
    // The one-way implication that survives optional fitment: requiring a
    // vehicle without being able to persist it would be a contradiction. The
    // converse does NOT hold — MOTOR_OIL can carry fitment without requiring it.
    for (const kind of Object.values(ProductKind)) {
      const caps = capabilitiesOf(kind);
      if (caps.requiredFields.includes('brand')) {
        expect(caps.hasVehicleFitment).toBe(true);
      }
    }
  });
});
