/**
 * Which build years the catalog supports for a Garage model.
 *
 * Three different years exist for a car, and only one is the Garage `year`:
 *
 *   - production (build) year, "год выпуска" on the registration certificate:
 *     the Garage `year`, the catalog's `year_from`/`year_to`, and the vehicle
 *     image registry's year ranges are all this year;
 *   - model year (a North American marketing year, VIN position 10): never
 *     inferred, since the backend does not decode VINs;
 *   - registration year (first registration in Uzbekistan): not collected, and
 *     never used.
 *
 * A model is checked against the range its catalog row states, and a generic
 * model whose generation rows all state verified ranges (Chevrolet `nexia` →
 * `nexia-1/2/3`) against those generations: a year no generation covers is not
 * a car that was built. A model the catalog states no range for is open, up to
 * next year (a car built late this year can carry next year's model year).
 */
import { variantsForYear, type VariantRow } from './vehicle-generation';

/** Uzbekistan keeps UTC+5 all year (no daylight saving). */
const UZ_OFFSET_MS = 5 * 60 * 60 * 1000;

export function currentYearInUzbekistan(now: Date = new Date()): number {
  return new Date(now.getTime() + UZ_OFFSET_MS).getUTCFullYear();
}

export interface YearRangeModel {
  yearFrom: number | null;
  yearTo: number | null;
  variants: VariantRow[];
}

/** The supported range when `year` is outside it; null when the year is supported. */
export function unsupportedYear(
  model: YearRangeModel,
  year: number,
  now: Date = new Date(),
): { year_from: number | null; year_to: number } | null {
  const latest = currentYearInUzbekistan(now) + 1;
  const ranged =
    model.variants.length > 0 &&
    model.variants.every((v) => v.yearFrom != null && v.yearTo != null);
  const ok =
    year <= latest &&
    (model.yearFrom == null || year >= model.yearFrom) &&
    (model.yearTo == null || year <= model.yearTo) &&
    (!ranged || variantsForYear(model.variants, year).length > 0);
  if (ok) return null;

  const from =
    model.yearFrom ??
    (ranged
      ? Math.min(...model.variants.map((v) => v.yearFrom as number))
      : null);
  const to = Math.min(
    model.yearTo ??
      (ranged
        ? Math.max(...model.variants.map((v) => v.yearTo as number))
        : latest),
    latest,
  );
  return { year_from: from, year_to: to };
}
