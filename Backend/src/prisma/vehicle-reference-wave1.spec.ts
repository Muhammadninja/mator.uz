import {
  cloneSnapshot,
  fakeReferenceDb,
  PROD_REFERENCE_2026_11_12 as PROD,
} from '../../test/utils/vehicle-reference-fixture';
import { WIZARD_BRANDS } from '../telegram/wizard-catalog';
import {
  WAVE1_HELD,
  WAVE1_MODELS,
} from './seed-data/vehicle-reference-wave1.seed';
import { isVehicleBodyType } from './vehicle-body-types';
import {
  REFERENCE_DATASETS,
  WAVE1_DATASET,
} from './vehicle-reference-datasets';
import {
  isBlocked,
  planVehicleReferenceSeed,
  ReferenceDataset,
  VEHICLE_REFERENCE_DATASET,
} from './vehicle-reference-plan';
import { formatVehicleReferenceReport } from './vehicle-reference-report';
import {
  referenceCacheKeys,
  ReferenceSeedAbort,
  runVehicleReferenceSeed,
} from './vehicle-reference-seed';

const TODAY = new Date('2026-11-12T12:00:00Z');
const plan = (snapshot = PROD, dataset: ReferenceDataset = WAVE1_DATASET) =>
  planVehicleReferenceSeed(dataset, snapshot, { today: TODAY });
const run = (
  prisma: Parameters<typeof runVehicleReferenceSeed>[0],
  apply = true,
) =>
  runVehicleReferenceSeed(prisma, {
    apply,
    dataset: WAVE1_DATASET,
    today: TODAY,
  });

/** Official manufacturer / distributor hosts Wave 1 may cite. */
const OFFICIAL_HOSTS = new Set([
  'chevrolet.uz',
  'volkswagen.uz',
  'www.volkswagen-newsroom.com',
  'www.byd.com',
]);

describe('Wave 1 dataset', () => {
  it('is selectable by name, next to the applied G-2 dataset', () => {
    expect(REFERENCE_DATASETS['wave-1']).toBe(WAVE1_DATASET);
    expect(REFERENCE_DATASETS.g2).toBe(VEHICLE_REFERENCE_DATASET);
  });

  it('creates no make and changes no make visibility', () => {
    expect(WAVE1_DATASET.makes).toEqual([]);
    expect(WAVE1_DATASET.makeStateChanges).toEqual([]);
    expect(WAVE1_DATASET.policy).toEqual({
      allowNewMakes: false,
      allowMakeStateChanges: false,
      requireAvailabilitySources: true,
    });
  });

  it('adds only Chevrolet Suburban', () => {
    expect(WAVE1_MODELS.map((m) => `${m.makeId}/${m.id}:${m.name}`)).toEqual([
      'chevrolet/suburban:Suburban',
    ]);
  });

  it('cites only official manufacturer/distributor pages, for every fact', () => {
    const urls = WAVE1_MODELS.flatMap((m) => [
      ...(m.availability ?? []).map((s) => s.url),
      ...[m.bodyType, m.yearFrom, m.yearTo]
        .filter((f) => f !== undefined)
        .map((f) => f.source.url),
    ]);
    const heldUrls = WAVE1_HELD.flatMap((h) => h.sources.map((s) => s.url));
    for (const url of [...urls, ...heldUrls]) {
      expect({
        url,
        official: OFFICIAL_HOSTS.has(new URL(url).hostname),
      }).toEqual({ url, official: true });
    }
  });

  it('sets no production year (the page shows only a model year on sale) and a vocabulary body type', () => {
    for (const m of WAVE1_MODELS) {
      expect(m.yearFrom).toBeUndefined();
      expect(m.yearTo).toBeUndefined();
      if (m.bodyType) expect(isVehicleBodyType(m.bodyType.value)).toBe(true);
    }
  });

  it('holds back every variant that would split name-based fitment', () => {
    expect(WAVE1_HELD.map((h) => `${h.makeId}:${h.name}`)).toEqual([
      'chevrolet:Equinox PHEV Activ',
      'chevrolet:Damas Move & Max',
      'volkswagen:Passat Pro',
      'volkswagen:Tiguan L Pro',
      'volkswagen:Teramont Pro',
      'volkswagen:Teramont X',
      'jetta:(Jetta brand models)',
      'byd:(any model beyond Chazor, Song Plus, Han)',
    ]);
  });

  it('does not reuse a name the seller bot already files under another model', () => {
    const chevy = WIZARD_BRANDS.find((b) => b.name === 'Chevrolet')!;
    expect(chevy.models).not.toContain('Suburban');
  });
});

describe('Wave 1 plan against the 2026-11-12 production snapshot', () => {
  it('adds Suburban after Chevrolet’s existing models, as an SUV with no years', () => {
    const p = plan();
    expect(p.errors).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.newMakes).toEqual([]);
    expect(p.stateChanges).toEqual([]);
    expect(p.newModels).toEqual([
      expect.objectContaining({
        id: 'suburban',
        makeId: 'chevrolet',
        name: 'Suburban',
        sortOrder: 25, // Chevrolet's 25 rows are 0–24 here
        bodyType: 'SUV',
        yearFrom: null,
        yearTo: null,
      }),
    ]);
    expect(p.newModels[0].sources).toEqual(
      expect.arrayContaining([
        expect.stringContaining('body_type: https://chevrolet.uz/ru/'),
      ]),
    );
  });

  it('touches no existing row and writes no fact on one', () => {
    const p = plan();
    expect(p.untouched).toEqual({
      makes: PROD.makes.length,
      models: PROD.models.length,
    });
    expect(p.preservedFacts).toEqual([]);
    expect(p.held).toHaveLength(WAVE1_HELD.length);
  });

  it('prints the held candidates and the sources in the dry-run', () => {
    const report = formatVehicleReferenceReport(plan(), {
      outcome: 'dry-run',
      target: 'snapshot',
    });
    for (const line of [
      'Wave 1 vehicle reference seed: DRY-RUN',
      "New models (1): appended after each make's existing models",
      'body_type SUV, year_from null, year_to null',
      'Held back, not planned (8)',
      '? volkswagen  Teramont X',
      'Facts for existing rows, NOT written (0)',
      'Summary: +0 makes, +1 models, 0 make-state change(s)',
      'Result: dry-run OK',
    ]) {
      expect(report).toContain(line);
    }
  });

  it('is blocked if another make already owns the id', () => {
    const snap = cloneSnapshot(PROD);
    snap.models.push({
      id: 'suburban',
      makeId: 'gmc',
      name: 'Suburban',
      sortOrder: 0,
    });
    snap.makes.push({
      id: 'gmc',
      name: 'GMC',
      isActive: false,
      comingSoon: false,
      sortOrder: 16,
    });
    const p = plan(snap);
    expect(p.errors).toEqual([
      expect.stringContaining('"suburban" already belongs to make "gmc"'),
    ]);
    expect(isBlocked(p)).toBe(true);
  });

  it('is blocked if Chevrolet already has a "Suburban" under another id', () => {
    const snap = cloneSnapshot(PROD);
    snap.models.push({
      id: 'chevrolet-suburban',
      makeId: 'chevrolet',
      name: 'Suburban',
      sortOrder: 25,
    });
    expect(plan(snap).conflicts).toEqual([
      expect.stringContaining('already has "Suburban" as "chevrolet-suburban"'),
    ]);
  });

  it('keeps an admin’s body type on an existing row and only reports the difference', () => {
    const snap = cloneSnapshot(PROD);
    snap.models.push({
      id: 'suburban',
      makeId: 'chevrolet',
      name: 'Suburban',
      sortOrder: 25,
      bodyType: 'Crossover',
    });
    const p = plan(snap);
    expect(isBlocked(p)).toBe(false);
    expect(p.newModels).toEqual([]);
    expect(p.unchangedModels).toEqual(['suburban']);
    expect(p.preservedFacts).toEqual([
      expect.stringContaining('bodyType stays "Crossover"'),
    ]);
  });
});

describe('G-2 against the 2026-11-12 snapshot', () => {
  it('stays blocked, so it can never re-deactivate Leapmotor or re-touch its makes', () => {
    const p = planVehicleReferenceSeed(VEHICLE_REFERENCE_DATASET, PROD);
    expect(isBlocked(p)).toBe(true);
    expect(p.conflicts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"ravon" already exists but is inactive'),
      ]),
    );
  });
});

describe('Wave 1 apply (in-memory database)', () => {
  it('creates one row with its sourced body type and leaves every existing row identical', async () => {
    const { prisma, writes, state } = fakeReferenceDb(PROD);
    const { applied } = await run(prisma);
    expect(applied).toBe(true);
    expect(writes).toEqual(['create model suburban']);
    expect(state().makes).toEqual(PROD.makes);
    const existing = new Set(PROD.models.map((m) => m.id));
    expect(state().models.filter((m) => existing.has(m.id))).toEqual(
      PROD.models,
    );
    expect(state().models.find((m) => m.id === 'suburban')).toEqual({
      id: 'suburban',
      makeId: 'chevrolet',
      name: 'Suburban',
      sortOrder: 25,
      yearFrom: null,
      yearTo: null,
      bodyType: 'SUV',
    });
  });

  it('is idempotent and clears only the makes list and Chevrolet’s models list', async () => {
    const { prisma, writes } = fakeReferenceDb(PROD);
    const first = await run(prisma);
    expect(referenceCacheKeys(first.plan)).toEqual([
      'cache:reference:makes',
      'cache:reference:models:chevrolet',
    ]);
    const second = await run(prisma);
    expect(second.applied).toBe(false);
    expect(second.plan.unchangedModels).toEqual(['suburban']);
    expect(second.plan.preservedFacts).toEqual([]);
    expect(writes).toHaveLength(1);
  });

  it('rolls back if an existing row’s body type changes underneath the write', async () => {
    const { prisma, db, state } = fakeReferenceDb(PROD);
    const create = db.vehicleModelRef.create.getMockImplementation()!;
    db.vehicleModelRef.create.mockImplementationOnce((args) => {
      state().models.find((m) => m.id === 'tahoe')!.bodyType = 'suv';
      return create(args);
    });
    await expect(run(prisma)).rejects.toThrow(
      'model "tahoe" changed unexpectedly',
    );
    expect(state()).toEqual(PROD);
  });

  it('refuses a dataset that would create a make or flip is_active, before any write', async () => {
    const { prisma, writes } = fakeReferenceDb(PROD);
    const bad: ReferenceDataset = {
      ...WAVE1_DATASET,
      makes: [{ id: 'jetta', name: 'Jetta', evidence: 'test' }],
      makeStateChanges: [
        {
          makeId: 'kia',
          isActive: true,
          requireNoModels: false,
          reason: 'test',
        },
      ],
    };
    const err = await runVehicleReferenceSeed(prisma, {
      apply: true,
      dataset: bad,
      today: TODAY,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReferenceSeedAbort);
    expect((err as ReferenceSeedAbort).plan.errors).toEqual(
      expect.arrayContaining([
        'this dataset may not create makes, but lists jetta',
        'this dataset may not change is_active of a make, but lists kia',
      ]),
    );
    expect(writes).toEqual([]);
  });
});

describe('Wave 1 with visual generation rows (migration 20261115000000)', () => {
  /** Nexia 1/2/3 as the variants migration leaves them on a fresh database. */
  const withNexiaVariants = () => {
    const snap = cloneSnapshot(PROD);
    [
      ['nexia-1', 1001, 1996, 2008],
      ['nexia-2', 1002, 2008, 2016],
      ['nexia-3', 1003, 2016, 2022],
    ].forEach(([id, sortOrder, yearFrom, yearTo]) =>
      Object.assign(
        snap.models.find((m) => m.id === id)!,
        {
          sortOrder,
          yearFrom,
          yearTo,
          variantOfModelId: 'nexia',
        },
      ),
    );
    return snap;
  };

  it('places Suburban after the picker’s rows, not after the hidden 1001+ generation rows', () => {
    const p = plan(withNexiaVariants());
    expect(p.errors).toEqual([]);
    expect(p.conflicts).toEqual([]);
    // Chevrolet's visible rows go up to 24 here (positional; nexia-1/2/3 moved out).
    expect(p.newModels.map((m) => [m.id, m.sortOrder])).toEqual([
      ['suburban', 25],
    ]);
  });

  it('never turns the new row into a generation row and leaves the Nexia rows identical', async () => {
    const snap = withNexiaVariants();
    const { prisma, state } = fakeReferenceDb(snap);
    await run(prisma);
    expect(state().models.filter((m) => m.id.startsWith('nexia'))).toEqual(
      snap.models.filter((m) => m.id.startsWith('nexia')),
    );
    const created = state().models.find((m) => m.id === 'suburban');
    expect(created?.variantOfModelId ?? null).toBeNull();
  });

  it('rolls back if a generation link changes underneath the write', async () => {
    const snap = withNexiaVariants();
    const { prisma, db, state } = fakeReferenceDb(snap);
    const create = db.vehicleModelRef.create.getMockImplementation()!;
    db.vehicleModelRef.create.mockImplementationOnce((args) => {
      state().models.find((m) => m.id === 'nexia-3')!.variantOfModelId = null;
      return create(args);
    });
    await expect(run(prisma)).rejects.toThrow(
      'model "nexia-3" changed unexpectedly',
    );
    expect(state()).toEqual(snap);
  });
});
