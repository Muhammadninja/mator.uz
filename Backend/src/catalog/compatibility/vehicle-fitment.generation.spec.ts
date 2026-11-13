// Wave 3: a Garage vehicle of a generic model (`nexia`) also matches parts filed
// under its RESOLVED generation row (`nexia-3`), and nothing else.
//
// Predicates are evaluated over in-memory parts (where-eval), so these assert
// which parts a vehicle sees, through the real vehicleFitWhere /
// compatibilityFacetWhere / computeCompatibility, not just predicate shapes.

import { computeCompatibility } from '../parts/part.presenter';
import { part, PARTS, VEHICLES } from './fitment-fixtures.test-util';
import {
  compatibilityFacetWhere,
  toVehicleFitContext,
  VehicleFitContext,
  VehicleFitRow,
  vehicleFitWhere,
} from './vehicle-fitment';
import { selectIds } from './where-eval.test-util';

/** The production Nexia generation rows (migration 20261115000000). */
const NEXIA_VARIANTS = [
  {
    id: 'nexia-1',
    makeId: 'chevrolet',
    name: 'Nexia 1',
    bodyType: null,
    yearFrom: 1996,
    yearTo: 2008,
  },
  {
    id: 'nexia-2',
    makeId: 'chevrolet',
    name: 'Nexia 2',
    bodyType: null,
    yearFrom: 2008,
    yearTo: 2016,
  },
  {
    id: 'nexia-3',
    makeId: 'chevrolet',
    name: 'Nexia 3',
    bodyType: 'Sedan',
    yearFrom: 2016,
    yearTo: 2022,
  },
];

/** A Garage row of the GENERIC `nexia` model, as VEHICLE_FIT_SELECT returns it. */
const nexiaRow = (
  year: number,
  over: { trimId?: string | null; variantModelId?: string | null } = {},
): VehicleFitRow => ({
  modelId: 'nexia',
  trimId: over.trimId ?? null,
  engineId: null,
  year,
  variantModelId: over.variantModelId ?? null,
  make: { name: 'Chevrolet' },
  model: { name: 'Nexia', variants: NEXIA_VARIANTS },
});
const nexia = (year: number, over?: Parameters<typeof nexiaRow>[1]) =>
  toVehicleFitContext(nexiaRow(year, over));

const CATALOG = [
  ...PARTS,
  part({ id: 'legacy_nexia2', fits: [['Chevrolet', 'Nexia 2']] }),
  part({ id: 'legacy_nexia1', fits: [['Chevrolet', 'Nexia 1']] }),
  // A different make's "Nexia 3": the make must match too.
  part({ id: 'legacy_daewoo_nexia3', fits: [['Daewoo', 'Nexia 3']] }),
  // Seller said "Nexia 3", the operator curated it to Nexia 2: curation wins.
  part({
    id: 'curated_nexia2_over_legacy_nexia3',
    curated: ['nexia-2'],
    fits: [['Chevrolet', 'Nexia 3']],
  }),
  part({ id: 'curated_generic_nexia', curated: ['nexia'] }),
];
const seenBy = (v: VehicleFitContext) => selectIds(CATALOG, vehicleFitWhere(v));

describe('toVehicleFitContext: generation resolution', () => {
  it('resolves the one generation whose verified years hold the vehicle year', () => {
    expect(nexia(2019)).toMatchObject({
      modelId: 'nexia',
      modelName: 'Nexia',
      generationModelId: 'nexia-3',
      generationModelName: 'Nexia 3',
    });
    expect(nexia(2010).generationModelId).toBe('nexia-2');
    expect(nexia(2000).generationModelId).toBe('nexia-1');
  });

  it('resolves nothing when two generations share the year and the owner has not picked', () => {
    expect(nexia(2016).generationModelId).toBeUndefined();
    expect(nexia(2008).generationModelId).toBeUndefined();
  });

  it('uses the owner pick for a shared year', () => {
    expect(nexia(2016, { variantModelId: 'nexia-2' }).generationModelId).toBe(
      'nexia-2',
    );
    expect(nexia(2016, { variantModelId: 'nexia-3' }).generationModelId).toBe(
      'nexia-3',
    );
  });

  it('ignores a pick that is not a candidate for the year (the year decides alone)', () => {
    expect(nexia(2019, { variantModelId: 'nexia-1' }).generationModelId).toBe(
      'nexia-3',
    );
    expect(
      nexia(2016, { variantModelId: 'nexia-1' }).generationModelId,
    ).toBeUndefined();
  });

  it('resolves nothing outside every range', () => {
    expect(nexia(2024).generationModelId).toBeUndefined();
    expect(nexia(1990).generationModelId).toBeUndefined();
  });

  it('leaves a model without generation rows exactly as before', () => {
    const cobalt = toVehicleFitContext({
      modelId: 'cobalt',
      trimId: null,
      engineId: null,
      year: 2022,
      variantModelId: null,
      make: { name: 'Chevrolet' },
      model: { name: 'Cobalt', variants: [] },
    });
    expect(cobalt).toEqual({
      modelId: 'cobalt',
      makeName: 'Chevrolet',
      modelName: 'Cobalt',
      trimId: null,
      engineId: null,
      year: 2022,
    });
  });

  it('tolerates a row read without the variants relation', () => {
    const row = {
      ...nexiaRow(2019),
      model: { name: 'Nexia' },
    } as unknown as VehicleFitRow;
    expect(toVehicleFitContext(row).generationModelId).toBeUndefined();
  });
});

describe('vehicleFitWhere: generic model with a resolved generation', () => {
  it('a 2019 Nexia sees Nexia 3 parts (legacy name and curated id), and no other generation', () => {
    const seen = seenBy(nexia(2019));
    expect(seen).toEqual(
      expect.arrayContaining([
        'legacy_nexia3',
        'curated_nexia3',
        'curated_multi',
      ]),
    );
    for (const id of ['legacy_nexia2', 'legacy_nexia1', 'curated_nexia2']) {
      expect(seen).not.toContain(id);
    }
  });

  it('a 2010 Nexia sees Nexia 2 parts, not Nexia 3', () => {
    const seen = seenBy(nexia(2010));
    expect(seen).toEqual(
      expect.arrayContaining(['legacy_nexia2', 'curated_nexia2']),
    );
    expect(seen).not.toContain('legacy_nexia3');
    expect(seen).not.toContain('curated_nexia3');
  });

  it('an unresolved Nexia (2016, no pick) sees no generation-specific part: skipped, not guessed', () => {
    const seen = seenBy(nexia(2016));
    for (const id of [
      'legacy_nexia1',
      'legacy_nexia2',
      'legacy_nexia3',
      'curated_nexia2',
      'curated_nexia3',
    ]) {
      expect(seen).not.toContain(id);
    }
  });

  it('keeps everything the generic model already saw', () => {
    for (const v of [nexia(2019), nexia(2016), nexia(2024)]) {
      expect(seenBy(v)).toEqual(
        expect.arrayContaining([
          'curated_generic_nexia',
          'makewide_chevrolet',
          'universal_oil',
        ]),
      );
    }
  });

  it('a generation name never matches another make', () => {
    expect(seenBy(nexia(2019))).not.toContain('legacy_daewoo_nexia3');
  });

  it('curation stays authoritative: a part curated to Nexia 2 is not shown to a Nexia 3 by its old "Nexia 3" row', () => {
    expect(seenBy(nexia(2019))).not.toContain(
      'curated_nexia2_over_legacy_nexia3',
    );
    expect(seenBy(nexia(2010))).toContain('curated_nexia2_over_legacy_nexia3');
  });

  it('changing the vehicle changes the result (no state carried over)', () => {
    expect(seenBy(nexia(2019))).toContain('legacy_nexia3');
    expect(seenBy(nexia(2010))).not.toContain('legacy_nexia3');
    expect(seenBy(nexia(2019))).toContain('legacy_nexia3');
  });
});

describe('predicates for vehicles without a resolved generation are unchanged', () => {
  it('Cobalt: the exact pre-Wave-3 listing predicate', () => {
    expect(vehicleFitWhere(VEHICLES.cobalt)).toEqual({
      OR: [
        { isUniversal: true },
        { fitmentBindings: { some: { vehicleModelId: 'cobalt' } } },
        {
          AND: [
            { fitmentBindings: { none: {} } },
            {
              OR: [
                {
                  fits: {
                    some: {
                      AND: [
                        {
                          makeName: {
                            equals: 'Chevrolet',
                            mode: 'insensitive',
                          },
                        },
                        {
                          modelName: { equals: 'Cobalt', mode: 'insensitive' },
                        },
                      ],
                    },
                  },
                },
                {
                  makeFits: {
                    some: {
                      makeName: { equals: 'Chevrolet', mode: 'insensitive' },
                    },
                  },
                },
              ],
            },
          ],
        },
        {
          compatibilities: {
            some: {
              AND: [
                {
                  OR: [
                    {
                      trimId: 't_cobalt',
                      OR: [
                        { years: { isEmpty: true } },
                        { years: { has: 2022 } },
                      ],
                    },
                  ],
                },
                { NOT: { status: 'DOES_NOT_FIT' } },
              ],
            },
          },
        },
      ],
    });
  });

  it('the unresolved Nexia uses the single-id binding shape', () => {
    expect(vehicleFitWhere(nexia(2016)).OR).toContainEqual({
      fitmentBindings: { some: { vehicleModelId: 'nexia' } },
    });
    expect(vehicleFitWhere(nexia(2019)).OR).toContainEqual({
      fitmentBindings: {
        some: { vehicleModelId: { in: ['nexia', 'nexia-3'] } },
      },
    });
  });
});

describe('card status and compatibility facet follow the same rule', () => {
  const NO_ROWS: Parameters<typeof computeCompatibility>[0] = [];

  it('a binding to the resolved generation is an exact fit on the card', () => {
    expect(
      computeCompatibility(NO_ROWS, nexia(2019), ['nexia-3'])?.status,
    ).toBe('fits');
  });

  it('a binding to another generation only is does_not_fit; an unresolved vehicle is not assumed to fit', () => {
    expect(
      computeCompatibility(NO_ROWS, nexia(2019), ['nexia-2'])?.status,
    ).toBe('does_not_fit');
    expect(
      computeCompatibility(NO_ROWS, nexia(2016), ['nexia-3'])?.status,
    ).toBe('does_not_fit');
  });

  it('the facet counts the generation-curated part as fits and the other generation as does-not-fit', () => {
    const facet = compatibilityFacetWhere(nexia(2019));
    expect(selectIds(CATALOG, facet.fits)).toEqual(
      expect.arrayContaining(['curated_nexia3', 'curated_generic_nexia']),
    );
    expect(selectIds(CATALOG, facet.fits)).not.toContain('curated_nexia2');
    expect(selectIds(CATALOG, facet.doesNotFit)).toContain('curated_nexia2');
    expect(selectIds(CATALOG, facet.doesNotFit)).not.toContain(
      'curated_nexia3',
    );
  });
});

describe('Nexia trims name their generation (nexia-N-* → Nexia N), when the year agrees', () => {
  it('maps each trim prefix to its own generation', () => {
    expect(nexia(2000, { trimId: 'nexia-1-base' }).generationModelId).toBe(
      'nexia-1',
    );
    expect(nexia(2010, { trimId: 'nexia-2-dlx' }).generationModelId).toBe(
      'nexia-2',
    );
    expect(nexia(2019, { trimId: 'nexia-3-ls' }).generationModelId).toBe(
      'nexia-3',
    );
  });

  it('settles a shared year that the year alone cannot (2016, 2008)', () => {
    expect(nexia(2016, { trimId: 'nexia-2-base' }).generationModelId).toBe(
      'nexia-2',
    );
    expect(nexia(2016, { trimId: 'nexia-3-lt' }).generationModelId).toBe(
      'nexia-3',
    );
    expect(nexia(2008, { trimId: 'nexia-1-base' }).generationModelId).toBe(
      'nexia-1',
    );
    expect(nexia(2008, { trimId: 'nexia-2-dlx' }).generationModelId).toBe(
      'nexia-2',
    );
  });

  it('names nothing when the trim contradicts the year', () => {
    expect(
      nexia(2010, { trimId: 'nexia-3-ls' }).generationModelId,
    ).toBeUndefined();
    expect(
      nexia(2019, { trimId: 'nexia-2-dlx' }).generationModelId,
    ).toBeUndefined();
    expect(
      nexia(2024, { trimId: 'nexia-3-ls' }).generationModelId,
    ).toBeUndefined();
  });

  it('names nothing for a trim outside the explicit list, or a look-alike prefix', () => {
    expect(
      nexia(2019, { trimId: 'nexia-sport' }).generationModelId,
    ).toBeUndefined();
    expect(
      nexia(2019, { trimId: 'nexia-30-x' }).generationModelId,
    ).toBeUndefined();
    expect(
      nexia(2019, { trimId: 'nexia3-ls' }).generationModelId,
    ).toBeUndefined();
  });

  it('names nothing when the generation row is missing from the catalog', () => {
    const row = {
      ...nexiaRow(2019, { trimId: 'nexia-3-ls' }),
      model: {
        name: 'Nexia',
        variants: NEXIA_VARIANTS.filter((r) => r.id !== 'nexia-3'),
      },
    };
    expect(toVehicleFitContext(row).generationModelId).toBeUndefined();
  });

  it('applies only to the generic nexia model, never to another model with a similar trim id', () => {
    const other = toVehicleFitContext({
      modelId: 'cobalt',
      trimId: 'nexia-3-ls',
      engineId: null,
      year: 2019,
      variantModelId: null,
      make: { name: 'Chevrolet' },
      model: { name: 'Cobalt', variants: NEXIA_VARIANTS },
    });
    expect(other.generationModelId).toBeUndefined();
  });

  it('a Nexia 3 trim sees Nexia 3 parts and keeps its own trim rows, not Nexia 2 parts', () => {
    const v = nexia(2019, { trimId: 'nexia-3-ls' });
    const trimPart = part({
      id: 'trim_nexia3_ls',
      compat: [{ trimId: 'nexia-3-ls', engineId: null, status: 'FITS' }],
    });
    const seen = selectIds([...CATALOG, trimPart], vehicleFitWhere(v));
    expect(seen).toEqual(
      expect.arrayContaining([
        'legacy_nexia3',
        'curated_nexia3',
        'trim_nexia3_ls',
      ]),
    );
    expect(seen).not.toContain('legacy_nexia2');
    expect(seen).not.toContain('curated_nexia2');
  });
});
