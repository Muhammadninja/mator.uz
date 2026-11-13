/**
 * Controlled vocabulary for `vehicle_models.body_type` on rows the reference
 * seed creates.
 *
 * The body type is part of the Vehicle Image Pipeline's canonical identity and
 * is hashed verbatim (`vehicle-image.identity.ts`), so "SUV", "suv" and
 * "crossover" would be three different images of one car. One lowercase token
 * per body, and no near-synonyms: a crossover is `suv`, a minivan is `mpv`, a
 * microvan is `van`, a micro pickup is `pickup`.
 *
 * Existing rows are never written by the seed (their body type stays as it is,
 * usually empty), so this list constrains new rows only.
 */
export const VEHICLE_BODY_TYPES = [
  'sedan',
  'hatchback',
  'liftback',
  'wagon',
  'coupe',
  'convertible',
  'suv',
  'mpv',
  'van',
  'pickup',
] as const;

export type VehicleBodyType = (typeof VEHICLE_BODY_TYPES)[number];

export const isVehicleBodyType = (value: unknown): value is VehicleBodyType =>
  typeof value === 'string' &&
  (VEHICLE_BODY_TYPES as readonly string[]).includes(value);
