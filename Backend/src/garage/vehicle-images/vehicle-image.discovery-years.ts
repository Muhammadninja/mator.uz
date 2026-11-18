import { DISCOVERY_YEAR_SAMPLES } from './vehicle-image.discovery-years.data';

/**
 * The old reference seed deliberately dropped UZ_GENERATIONS.yearRange. A single
 * existing catalog generation supplies one known model-year sample for private
 * candidate acquisition, without asserting a production end, market or visual
 * generation. Multiple generations require a person; never pick one silently.
 */
export function discoveryYearSample(model: {
  id: string;
  makeId: string;
}):
  | { year: number; sourceGenerationId: string }
  | {
      reason:
        'model_year_range_missing' | 'model_generation_selection_required';
    } {
  const samples = DISCOVERY_YEAR_SAMPLES.filter(
    (sample) => sample.makeId === model.makeId && sample.modelId === model.id,
  );
  if (samples.length !== 1) {
    return {
      reason: samples.length
        ? 'model_generation_selection_required'
        : 'model_year_range_missing',
    };
  }
  return {
    year: samples[0].year,
    sourceGenerationId: samples[0].sourceGenerationId,
  };
}

export function discoveryReviewAction(reason: string | null): string {
  if (
    reason === 'generation_year_ranges_overlap' ||
    reason === 'model_generation_selection_required'
  )
    return 'review_generation_selection';
  if (reason?.includes('year_range')) return 'supply_sourced_production_years';
  if (reason === 'generation_make_mismatch')
    return 'correct_generation_make_link';
  return 'review_catalog_identity';
}
