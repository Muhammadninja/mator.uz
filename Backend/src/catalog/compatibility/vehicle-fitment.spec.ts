// Regression tests for the buyer compatibility decision path (vehicleFitWhere).
//
// The predicate is evaluated over in-memory fixture parts (where-eval), so these
// assert WHICH parts a garage vehicle sees — not merely the predicate's shape.
// Mocked/in-memory: they prove the predicate's logic, not PostgreSQL's SQL.

import { vehicleFitWhere, toVehicleFitContext } from './vehicle-fitment';
import { selectIds } from './where-eval.test-util';
import { PARTS, VEHICLES, vehicleRow } from './fitment-fixtures.test-util';

const seenBy = (v: (typeof VEHICLES)[keyof typeof VEHICLES]) =>
  selectIds(PARTS, vehicleFitWhere(v));

describe('vehicleFitWhere — curated fitment (fitment_bindings by model id)', () => {
  it('Part → Cobalt: a Cobalt sees it', () => {
    expect(seenBy(VEHICLES.cobalt)).toContain('curated_cobalt');
  });

  it('Part → Cobalt: a Spark does NOT see it (same make is not enough)', () => {
    expect(seenBy(VEHICLES.spark)).not.toContain('curated_cobalt');
  });

  it('Part → Spark: a Cobalt does NOT see it', () => {
    expect(seenBy(VEHICLES.cobalt)).not.toContain('curated_spark');
  });

  it('Part → Cobalt + Gentra + Nexia 3: all three see it, others do not', () => {
    expect(seenBy(VEHICLES.cobalt)).toContain('curated_multi');
    expect(seenBy(VEHICLES.gentra)).toContain('curated_multi');
    expect(seenBy(VEHICLES.nexia3)).toContain('curated_multi');
    expect(seenBy(VEHICLES.spark)).not.toContain('curated_multi');
    expect(seenBy(VEHICLES.nexia2)).not.toContain('curated_multi');
  });

  it('Nexia 2 ≠ Nexia 3: each binding reaches only its own model id', () => {
    expect(seenBy(VEHICLES.nexia2)).toContain('curated_nexia2');
    expect(seenBy(VEHICLES.nexia2)).not.toContain('curated_nexia3');
    expect(seenBy(VEHICLES.nexia3)).toContain('curated_nexia3');
    expect(seenBy(VEHICLES.nexia3)).not.toContain('curated_nexia2');
  });

  it('matches on the reference id, never on the model name', () => {
    // A vehicle whose NAME says Cobalt but whose model id is something else
    // must not pick up a part curated to the `cobalt` id.
    const misnamed = { ...VEHICLES.spark, modelName: 'Cobalt' };
    expect(selectIds(PARTS, vehicleFitWhere(misnamed))).not.toContain(
      'curated_cobalt',
    );
  });

  it('curation is authoritative over the part legacy per-model rows', () => {
    // Seller row says Cobalt, operator curated Spark → only Spark sees it.
    expect(seenBy(VEHICLES.cobalt)).not.toContain('curated_overrides_legacy');
    expect(seenBy(VEHICLES.spark)).toContain('curated_overrides_legacy');
  });

  it('curated model fitment never turns into make-wide fitment', () => {
    // Imported Chevrolet-wide, curated to Gentra → a Cobalt no longer sees it.
    expect(seenBy(VEHICLES.cobalt)).not.toContain('curated_overrides_makewide');
    expect(seenBy(VEHICLES.gentra)).toContain('curated_overrides_makewide');
  });
});

describe('vehicleFitWhere — legacy, make-wide, universal, trim', () => {
  it('a legacy Spark-only part is NOT shown to a Cobalt (the old model-OR-make bug)', () => {
    expect(seenBy(VEHICLES.cobalt)).not.toContain('legacy_spark');
    expect(seenBy(VEHICLES.spark)).toContain('legacy_spark');
  });

  it('a legacy per-model row still matches its own make+model', () => {
    expect(seenBy(VEHICLES.cobalt)).toContain('legacy_cobalt');
    expect(seenBy(VEHICLES.nexia3)).toContain('legacy_nexia3');
    expect(seenBy(VEHICLES.nexia2)).not.toContain('legacy_nexia3');
  });

  it('a make-wide part is visible across its make, and only its make', () => {
    for (const v of [VEHICLES.cobalt, VEHICLES.spark, VEHICLES.nexia2]) {
      expect(seenBy(v)).toContain('makewide_chevrolet');
    }
    expect(seenBy(VEHICLES.rio)).not.toContain('makewide_chevrolet');
  });

  it('a universal part is visible to every vehicle', () => {
    for (const v of Object.values(VEHICLES)) {
      expect(seenBy(v)).toContain('universal_oil');
    }
  });

  it('a trim row still widens the listing for its trim', () => {
    expect(seenBy(VEHICLES.cobalt)).toContain('trim_t_cobalt');
    expect(seenBy(VEHICLES.spark)).not.toContain('trim_t_cobalt');
  });

  it('a part with no fitment data is never shown for a vehicle', () => {
    for (const v of Object.values(VEHICLES)) {
      expect(seenBy(v)).not.toContain('no_fitment');
    }
  });

  it('the full Cobalt view is exactly the expected set', () => {
    expect(seenBy(VEHICLES.cobalt).sort()).toEqual(
      [
        'curated_cobalt',
        'curated_multi',
        'legacy_cobalt',
        'makewide_chevrolet',
        'trim_t_cobalt',
        'universal_oil',
      ].sort(),
    );
  });
});

describe('where-eval sanity — the evaluator really catches the old bug', () => {
  it('the PREVIOUS predicate (fit row matching model OR make) leaked Spark-only parts to a Cobalt', () => {
    // Verbatim shape of the pre-fix PartsService.vehicleWhere fit clause.
    const previous = {
      OR: [
        { isUniversal: true },
        {
          fits: {
            some: {
              AND: [
                {
                  OR: [
                    { modelName: { equals: 'Cobalt', mode: 'insensitive' } },
                    { makeName: { equals: 'Chevrolet', mode: 'insensitive' } },
                  ],
                },
              ],
            },
          },
        },
      ],
    };
    expect(selectIds(PARTS, previous)).toContain('legacy_spark');
    // …and the shared helper does not.
    expect(seenBy(VEHICLES.cobalt)).not.toContain('legacy_spark');
  });
});

describe('toVehicleFitContext', () => {
  it('carries the stable model id through from the garage row', () => {
    expect(toVehicleFitContext(vehicleRow(VEHICLES.nexia3) as never)).toEqual(
      VEHICLES.nexia3,
    );
  });
});
