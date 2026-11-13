import { currentYearInUzbekistan, unsupportedYear } from './vehicle-year';

const NOW = new Date('2026-11-13T12:00:00Z');
const v = (id: string, yearFrom: number | null, yearTo: number | null) => ({
  id,
  makeId: 'chevrolet',
  name: id,
  bodyType: null,
  yearFrom,
  yearTo,
});
const NEXIA = {
  yearFrom: null,
  yearTo: null,
  variants: [
    v('nexia-1', 1996, 2008),
    v('nexia-2', 2008, 2016),
    v('nexia-3', 2016, 2022),
  ],
};
const OPEN = { yearFrom: null, yearTo: null, variants: [] };

describe('currentYearInUzbekistan', () => {
  it('turns the year at midnight Tashkent time (UTC+5), not UTC', () => {
    expect(currentYearInUzbekistan(new Date('2026-12-31T18:59:59Z'))).toBe(
      2026,
    );
    expect(currentYearInUzbekistan(new Date('2026-12-31T19:00:00Z'))).toBe(
      2027,
    );
  });
});

describe('unsupportedYear (build year)', () => {
  it('a model with no stated range is open up to next year', () => {
    expect(unsupportedYear(OPEN, 1985, NOW)).toBeNull();
    expect(unsupportedYear(OPEN, 2027, NOW)).toBeNull();
    expect(unsupportedYear(OPEN, 2028, NOW)).toEqual({
      year_from: null,
      year_to: 2027,
    });
  });

  it("a model's own stated range is enforced", () => {
    const r3 = { yearFrom: 2016, yearTo: 2022, variants: [] };
    expect(unsupportedYear(r3, 2016, NOW)).toBeNull();
    expect(unsupportedYear(r3, 2022, NOW)).toBeNull();
    expect(unsupportedYear(r3, 2015, NOW)).toEqual({
      year_from: 2016,
      year_to: 2022,
    });
    expect(unsupportedYear(r3, 2023, NOW)).toEqual({
      year_from: 2016,
      year_to: 2022,
    });
    const current = { yearFrom: 2013, yearTo: null, variants: [] };
    expect(unsupportedYear(current, 2028, NOW)).toEqual({
      year_from: 2013,
      year_to: 2027,
    });
  });

  it('a generic model is held to its verified generations', () => {
    for (const year of [1996, 2008, 2016, 2022])
      expect(unsupportedYear(NEXIA, year, NOW)).toBeNull();
    for (const year of [1995, 2023, 2026])
      expect(unsupportedYear(NEXIA, year, NOW)).toEqual({
        year_from: 1996,
        year_to: 2022,
      });
  });

  it('a gap between verified generations is refused', () => {
    const gappy = {
      ...NEXIA,
      variants: [v('a', 2000, 2004), v('b', 2010, 2014)],
    };
    expect(unsupportedYear(gappy, 2007, NOW)).toEqual({
      year_from: 2000,
      year_to: 2014,
    });
  });

  it('an open generation range is not verified, so it never refuses', () => {
    const open = {
      ...NEXIA,
      variants: [v('a', 2000, 2004), v('b', 2010, null)],
    };
    expect(unsupportedYear(open, 2007, NOW)).toBeNull();
    expect(unsupportedYear(open, 2027, NOW)).toBeNull();
  });
});
