import {
  imageSubject,
  presentGeneration,
  resolveGeneration,
  type VariantRow,
} from './vehicle-generation';

// The Chevrolet Nexia rows exactly as migration 20261115000000 sets them.
const N100: VariantRow = {
  id: 'nexia-1',
  makeId: 'chevrolet',
  name: 'Nexia 1',
  bodyType: null,
  yearFrom: 1996,
  yearTo: 2008,
};
const N150: VariantRow = {
  ...N100,
  id: 'nexia-2',
  name: 'Nexia 2',
  yearFrom: 2008,
  yearTo: 2016,
};
const R3: VariantRow = {
  ...N100,
  id: 'nexia-3',
  name: 'Nexia 3',
  yearFrom: 2016,
  yearTo: 2022,
};
const NEXIA = [R3, N100, N150]; // unordered on purpose

const resolve = (
  year: number,
  over: {
    trimId?: string | null;
    chosen?: string | null;
    variants?: VariantRow[];
  } = {},
) =>
  resolveGeneration({
    year,
    trimId: over.trimId ?? null,
    variants: over.variants ?? NEXIA,
    chosenVariantId: over.chosen ?? null,
  });

describe('resolveGeneration (Chevrolet Nexia data)', () => {
  it.each([
    [1995, 'unresolved', null],
    [1996, 'resolved', 'nexia-1'],
    [2007, 'resolved', 'nexia-1'],
    [2008, 'choice_required', null],
    [2009, 'resolved', 'nexia-2'],
    [2015, 'resolved', 'nexia-2'],
    [2016, 'choice_required', null],
    [2017, 'resolved', 'nexia-3'],
    [2022, 'resolved', 'nexia-3'],
    [2023, 'unresolved', null],
    [2026, 'unresolved', null],
  ])('%i → %s %s', (year, status, variant) => {
    const r = resolve(year);
    expect(r?.status).toBe(status);
    expect(r && r.status === 'resolved' ? r.variant.id : null).toBe(variant);
    if (r?.status === 'resolved') expect(r.source).toBe('year');
  });

  it('offers exactly the two generations of an overlap year, oldest first', () => {
    expect(resolve(2016)).toEqual({
      status: 'choice_required',
      options: [N150, R3],
    });
    expect(resolve(2008)).toEqual({
      status: 'choice_required',
      options: [N100, N150],
    });
  });

  it("keeps the owner's pick while it is one of the year's options", () => {
    expect(resolve(2016, { chosen: 'nexia-3' })).toEqual({
      status: 'resolved',
      source: 'owner',
      variant: R3,
      options: [N150, R3],
    });
  });

  it('ignores a pick the year does not allow, and never lets one override the year', () => {
    expect(resolve(2016, { chosen: 'nexia-1' })?.status).toBe(
      'choice_required',
    );
    expect(resolve(2018, { chosen: 'nexia-2' })).toMatchObject({
      source: 'year',
      variant: R3,
    });
    expect(resolve(2024, { chosen: 'nexia-3' })).toEqual({
      status: 'unresolved',
    });
  });

  it('a picked trim wins: no resolution at all', () => {
    expect(resolve(2016, { trimId: 'nexia-3-ls' })).toBeNull();
    expect(resolve(2018, { trimId: 'nexia-2-dlx' })).toBeNull();
  });

  it('a model without generation rows is untouched', () => {
    expect(resolve(2016, { variants: [] })).toBeNull();
  });

  it('only fully dated rows count; an open range is never treated as verified', () => {
    const open = { ...R3, yearTo: null };
    expect(resolve(2018, { variants: [N150, open] })).toEqual({
      status: 'unresolved',
    });
  });
});

describe('presentGeneration', () => {
  it('is null for ordinary vehicles', () => {
    expect(presentGeneration(null)).toBeNull();
  });

  it('a resolved year names the catalog row and offers nothing', () => {
    expect(presentGeneration(resolve(2018))).toEqual({
      status: 'resolved',
      source: 'year',
      model: { id: 'nexia-3', name: 'Nexia 3' },
      options: [],
    });
  });

  it('an overlap year lists the backend options with their build years', () => {
    expect(presentGeneration(resolve(2016))).toEqual({
      status: 'choice_required',
      source: null,
      model: null,
      options: [
        { id: 'nexia-2', name: 'Nexia 2', year_from: 2008, year_to: 2016 },
        { id: 'nexia-3', name: 'Nexia 3', year_from: 2016, year_to: 2022 },
      ],
    });
  });

  it("an owner's pick keeps the options so it can be changed", () => {
    expect(
      presentGeneration(resolve(2016, { chosen: 'nexia-2' })),
    ).toMatchObject({
      status: 'resolved',
      source: 'owner',
      model: { id: 'nexia-2', name: 'Nexia 2' },
      options: [{ id: 'nexia-2' }, { id: 'nexia-3' }],
    });
  });

  it('an unsupported year is unresolved, with no options', () => {
    expect(presentGeneration(resolve(2023))).toEqual({
      status: 'unresolved',
      source: null,
      model: null,
      options: [],
    });
  });
});

describe('imageSubject', () => {
  const generic: VariantRow = {
    ...N100,
    id: 'nexia',
    name: 'Nexia',
    yearFrom: null,
    yearTo: null,
  };

  it('pictures the resolved generation row, or the model itself when nothing resolves', () => {
    expect(imageSubject(generic, resolve(2018))).toEqual({ model: R3 });
    expect(imageSubject(generic, null)).toEqual({ model: generic });
  });

  it('flags an open generation for review instead of asking for the generic model', () => {
    expect(imageSubject(generic, resolve(2016))).toEqual({
      review: 'generation_unresolved',
    });
    expect(imageSubject(generic, resolve(2023))).toEqual({
      review: 'generation_unresolved',
    });
  });
});
