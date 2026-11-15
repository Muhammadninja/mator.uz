import { discoveryYearSample } from './vehicle-image.discovery-years';

describe('explicit catalog-year samples', () => {
  it('uses the known Tracker start year, without a guessed end, market or visual identity', () => {
    expect(discoveryYearSample({ id: 'tracker', makeId: 'chevrolet' })).toEqual(
      {
        year: 2020,
        sourceGenerationId: 'tracker-3',
      },
    );
  });

  it('does not treat another make, name alias, or multiple generations as an exact source', () => {
    expect(
      discoveryYearSample({ id: 'tracker', makeId: 'unverified-make' }),
    ).toEqual({ reason: 'model_year_range_missing' });
    expect(
      discoveryYearSample({ id: 'tracker-2', makeId: 'chevrolet' }),
    ).toEqual({ reason: 'model_year_range_missing' });
    expect(discoveryYearSample({ id: 'malibu', makeId: 'chevrolet' })).toEqual({
      reason: 'model_generation_selection_required',
    });
  });
});
