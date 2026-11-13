/**
 * Controlled vocabulary for `vehicle_models.body_type` on rows the reference
 * seed creates.
 *
 * The body type is part of the Vehicle Image Pipeline's canonical identity and
 * is hashed verbatim (`vehicle-image.identity.ts`), so "SUV", "suv" and
 * "Crossover" would be three different images of one car. One spelling per
 * body, and no near-synonyms: a crossover is `SUV`, a minivan is `MPV`, a
 * microvan is `Van`, a micro pickup is `Pickup`.
 *
 * Spelling follows the admin console's existing rows (owner decision
 * 2026-11-13): title case, as admins typed "Sedan", "SUV", "Hatchback",
 * "Liftback" and "Panel Van" on 23 production models.
 *
 * Existing rows are never written by the seed (their body type stays as it is,
 * usually empty), so this list constrains new rows only.
 */
export const VEHICLE_BODY_TYPES = [
  'Sedan',
  'Hatchback',
  'Liftback',
  'Wagon',
  'Coupe',
  'Convertible',
  'SUV',
  'MPV',
  'Van',
  'Panel Van',
  'Pickup',
] as const;

export type VehicleBodyType = (typeof VEHICLE_BODY_TYPES)[number];

export const isVehicleBodyType = (value: unknown): value is VehicleBodyType =>
  typeof value === 'string' &&
  (VEHICLE_BODY_TYPES as readonly string[]).includes(value);
