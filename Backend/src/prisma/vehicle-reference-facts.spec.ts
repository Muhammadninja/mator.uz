import type {
  SeedReferenceModel,
  SourceRef,
} from './seed-data/vehicle-reference.seed';
import { modelFactErrors, plannedFacts } from './vehicle-reference-facts';

const TODAY = new Date('2026-11-12T12:00:00Z');
const SRC: SourceRef = {
  url: 'https://chevrolet.uz/ru/',
  publisher: 'UzAuto Motors',
  accessedOn: '2026-11-12',
  quote: 'SUV',
};
const model = (over: Partial<SeedReferenceModel> = {}): SeedReferenceModel => ({
  id: 'x',
  makeId: 'chevrolet',
  name: 'X',
  evidence: 'test',
  availability: [SRC],
  ...over,
});
const errors = (m: SeedReferenceModel, requireAvailability = true) =>
  modelFactErrors(m, { requireAvailability, today: TODAY });

describe('modelFactErrors', () => {
  it('accepts a fully sourced model', () => {
    expect(
      errors(
        model({
          bodyType: { value: 'suv', source: SRC },
          yearFrom: { value: 2020, source: SRC },
          yearTo: { value: 2024, source: SRC },
        }),
      ),
    ).toEqual([]);
  });

  it('requires an availability source only when the policy asks for one', () => {
    expect(errors(model({ availability: [] }))).toEqual([
      expect.stringContaining('needs at least one official source'),
    ]);
    expect(errors(model({ availability: undefined }), false)).toEqual([]);
  });

  it('refuses a fact without a usable source', () => {
    const bad = (source: Partial<SourceRef>) =>
      errors(model({ yearFrom: { value: 2020, source: source as SourceRef } }));
    expect(bad({ ...SRC, url: 'http://chevrolet.uz/' })).toEqual([
      expect.stringContaining('is not an https URL'),
    ]);
    expect(bad({ ...SRC, url: 'not a url' })).toEqual([
      expect.stringContaining('is not an https URL'),
    ]);
    expect(bad({ ...SRC, publisher: ' ' })).toEqual([
      expect.stringContaining('publisher is blank'),
    ]);
    expect(bad({ ...SRC, quote: '' })).toEqual([
      expect.stringContaining('quote is blank'),
    ]);
    expect(bad({ ...SRC, accessedOn: '2026-02-30' })).toEqual([
      expect.stringContaining('is not a YYYY-MM-DD date'),
    ]);
    expect(bad({ ...SRC, accessedOn: '2026-11-13' })).toEqual([
      expect.stringContaining('is in the future'),
    ]);
    expect(
      errors(
        model({
          bodyType: { value: 'suv', source: undefined as unknown as SourceRef },
        }),
      ),
    ).toEqual([expect.stringContaining('bodyType: a source is required')]);
  });

  it('allows only the controlled body-type vocabulary', () => {
    for (const value of ['SUV', 'crossover', 'minivan', 'Sedan ']) {
      expect(errors(model({ bodyType: { value, source: SRC } }))).toEqual([
        expect.stringContaining(`body type "${value}" is not one of`),
      ]);
    }
  });

  it('refuses impossible or reversed years', () => {
    expect(errors(model({ yearFrom: { value: 1885, source: SRC } }))).toEqual([
      expect.stringContaining('1885 is not a year between 1886 and 2027'),
    ]);
    expect(errors(model({ yearTo: { value: 2028, source: SRC } }))).toEqual([
      expect.stringContaining('2028 is not a year'),
    ]);
    expect(errors(model({ yearFrom: { value: 2020.5, source: SRC } }))).toEqual(
      [expect.stringContaining('is not a year')],
    );
    expect(
      errors(
        model({
          yearFrom: { value: 2022, source: SRC },
          yearTo: { value: 2021, source: SRC },
        }),
      ),
    ).toEqual(['model x: yearTo 2021 is before yearFrom 2022']);
  });
});

describe('plannedFacts', () => {
  it('writes null for every fact the dataset does not state', () => {
    expect(plannedFacts(model())).toEqual({
      yearFrom: null,
      yearTo: null,
      bodyType: null,
    });
    expect(
      plannedFacts(model({ bodyType: { value: 'van', source: SRC } })),
    ).toEqual({ yearFrom: null, yearTo: null, bodyType: 'van' });
  });
});
