/**
 * Which generation a Garage vehicle of a generic model is, for its picture.
 *
 * A generic catalog model (`nexia`) can have generation-specific rows that point
 * at it through `variant_of_model_id` (`nexia-1`, `nexia-2`, `nexia-3`), each with
 * the build years in `year_from`/`year_to`. Nothing here is model-specific, and
 * nothing reads a trim id, a VIN or a display name.
 *
 *   - A picked catalog trim is the owner's own, more precise answer: no
 *     resolution, and no pick is accepted.
 *   - Only rows with both years count; an open range is never a verified one.
 *   - One row covers the year → that generation. Several → the owner chooses
 *     among them, and the choice is kept. None → unresolved, nothing inferred.
 *
 * Visual identity only. Fitment keeps reading the vehicle's own `model_id`.
 */
import { IMAGE_REVIEW_REASONS } from '../vehicle-images/vehicle-image.identity';

/** A generation-specific catalog row, as read from `vehicle_models`. */
export interface VariantRow {
  id: string;
  makeId: string;
  name: string;
  bodyType: string | null;
  yearFrom: number | null;
  yearTo: number | null;
}

export type GenerationResolution =
  | {
      status: 'resolved';
      source: 'year' | 'owner';
      variant: VariantRow;
      /** The rows the owner chose from (empty when the year decided). */
      options: VariantRow[];
    }
  | { status: 'choice_required'; options: VariantRow[] }
  | { status: 'unresolved' };

export interface GenerationInput {
  year: number;
  trimId: string | null;
  variants: VariantRow[];
  /** The owner's stored pick (`vehicles.variant_model_id`). */
  chosenVariantId: string | null;
}

/** The rows whose verified build years include `year`, oldest first. */
export function variantsForYear(
  variants: VariantRow[],
  year: number,
): VariantRow[] {
  return variants
    .filter(
      (v) =>
        v.yearFrom != null &&
        v.yearTo != null &&
        year >= v.yearFrom &&
        year <= v.yearTo,
    )
    .sort(
      (a, b) =>
        (a.yearFrom as number) - (b.yearFrom as number) ||
        a.id.localeCompare(b.id),
    );
}

/** Null when the model has no generation rows, or a trim was picked. */
export function resolveGeneration(
  input: GenerationInput,
): GenerationResolution | null {
  if (input.variants.length === 0 || input.trimId) return null;
  const candidates = variantsForYear(input.variants, input.year);
  if (candidates.length === 0) return { status: 'unresolved' };
  if (candidates.length === 1) {
    return {
      status: 'resolved',
      source: 'year',
      variant: candidates[0],
      options: [],
    };
  }
  // A stored pick counts only while it is still one of this year's candidates.
  const chosen = candidates.find((v) => v.id === input.chosenVariantId);
  return chosen
    ? {
        status: 'resolved',
        source: 'owner',
        variant: chosen,
        options: candidates,
      }
    : { status: 'choice_required', options: candidates };
}

const presentOption = (v: VariantRow) => ({
  id: v.id,
  name: v.name,
  year_from: v.yearFrom,
  year_to: v.yearTo,
});

/** The `generation` field of a Garage vehicle response. */
export function presentGeneration(resolution: GenerationResolution | null) {
  if (!resolution) return null;
  switch (resolution.status) {
    case 'resolved':
      return {
        status: 'resolved' as const,
        source: resolution.source,
        model: { id: resolution.variant.id, name: resolution.variant.name },
        options: resolution.options.map(presentOption),
      };
    case 'choice_required':
      return {
        status: 'choice_required' as const,
        source: null,
        model: null,
        options: resolution.options.map(presentOption),
      };
    default:
      return {
        status: 'unresolved' as const,
        source: null,
        model: null,
        options: [],
      };
  }
}

/**
 * The catalog row a vehicle's picture is of: its own model when the model has no
 * generation rows (or a trim was picked), the resolved generation's row, and
 * otherwise no row: the picture stays a placeholder and is flagged for review.
 */
export function imageSubject<M extends VariantRow>(
  model: M,
  resolution: GenerationResolution | null,
):
  | { model: VariantRow }
  | { review: typeof IMAGE_REVIEW_REASONS.GENERATION_UNRESOLVED } {
  if (!resolution) return { model };
  return resolution.status === 'resolved'
    ? { model: resolution.variant }
    : { review: IMAGE_REVIEW_REASONS.GENERATION_UNRESOLVED };
}
