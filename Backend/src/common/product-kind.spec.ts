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
  isUniversalKind,
} from './product-kind';

describe('ProductKind capability table', () => {
  it('describes a spare part as vehicle-specific with part numbers', () => {
    expect(capabilitiesOf(ProductKind.SPARE_PART)).toEqual({
      hasVehicleFitment: true,
      hasPartNumbers: true,
      hasVehicleCategory: true,
      requiredFields: ['brand', 'model', 'category'],
    });
  });

  it('describes a motor oil as universal with no part numbers', () => {
    expect(capabilitiesOf(ProductKind.MOTOR_OIL)).toEqual({
      hasVehicleFitment: false,
      hasPartNumbers: false,
      hasVehicleCategory: false,
      requiredFields: ['oilViscosity', 'oilType', 'oilVolumeMl'],
    });
  });
});

describe('derived predicates stay consistent with the table', () => {
  it('universality is the exact complement of vehicle fitment', () => {
    // These two must never disagree: a kind that collects no fitment IS
    // universal. Deriving one from the other makes that structural.
    for (const kind of Object.values(ProductKind)) {
      expect(isUniversalKind(kind)).toBe(
        !capabilitiesOf(kind).hasVehicleFitment,
      );
    }
  });

  it('compatibility applies exactly when fitment is collected', () => {
    for (const kind of Object.values(ProductKind)) {
      expect(hasCompatibility(kind)).toBe(
        capabilitiesOf(kind).hasVehicleFitment,
      );
    }
  });

  it('a universal kind never has compatibility, and vice versa', () => {
    for (const kind of Object.values(ProductKind)) {
      expect(isUniversalKind(kind)).toBe(!hasCompatibility(kind));
    }
  });

  it('answers the concrete cases the product relies on', () => {
    expect(isUniversalKind(ProductKind.MOTOR_OIL)).toBe(true);
    expect(isUniversalKind(ProductKind.SPARE_PART)).toBe(false);
    expect(hasCompatibility(ProductKind.MOTOR_OIL)).toBe(false);
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

  it('a kind that collects fitment requires brand and model', () => {
    // Fitment cannot be persisted without them (persistVehicleLinks skips a pair
    // with no brand), so the two facts must agree.
    for (const kind of Object.values(ProductKind)) {
      const caps = capabilitiesOf(kind);
      if (caps.hasVehicleFitment) {
        expect(caps.requiredFields).toEqual(
          expect.arrayContaining(['brand', 'model']),
        );
      } else {
        expect(caps.requiredFields).not.toEqual(
          expect.arrayContaining(['brand', 'model']),
        );
      }
    }
  });
});
