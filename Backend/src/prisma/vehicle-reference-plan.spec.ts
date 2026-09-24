import {
  cloneSnapshot,
  PROD_REFERENCE_2026_09_25 as PROD,
  referenceMake,
} from '../../test/utils/vehicle-reference-fixture';
import {
  resolveMake,
  resolveModel,
} from '../imports/drivers-village/drivers-village-vehicle.mapper';
import { WIZARD_BRANDS } from '../telegram/wizard-catalog';
import {
  REFERENCE_MAKE_STATE_CHANGES,
  REFERENCE_NEW_MAKES,
  REFERENCE_NEW_MODELS,
  SeedReferenceModel,
} from './seed-data/vehicle-reference.seed';
import {
  isBlocked,
  planVehicleReferenceSeed,
  ReferenceDataset,
  VEHICLE_REFERENCE_DATASET,
} from './vehicle-reference-plan';

const plan = (snapshot = PROD, dataset = VEHICLE_REFERENCE_DATASET) =>
  planVehicleReferenceSeed(dataset, snapshot);
const only = (over: Partial<ReferenceDataset>): ReferenceDataset => ({
  makes: [],
  models: [],
  makeStateChanges: [],
  ...over,
});
const chevy = (id: string, name: string): SeedReferenceModel => ({
  id,
  makeId: 'chevrolet',
  name,
  evidence: 'test',
});

describe('G-2 dataset (frozen Phase 1 audit)', () => {
  it('adds exactly the audited pairs: 4 makes, 17 models', () => {
    expect(REFERENCE_NEW_MAKES.map((m) => `${m.id}:${m.name}`)).toEqual([
      'ravon:Ravon',
      'ssangyong:SsangYong',
      'skoda:Skoda',
      'genesis:Genesis',
    ]);
    expect(
      REFERENCE_NEW_MODELS.map((m) => `${m.makeId}/${m.id}:${m.name}`),
    ).toEqual([
      'chevrolet/chevrolet-matiz:Matiz',
      'chevrolet/equinox:Equinox',
      'chevrolet/traverse:Traverse',
      'chevrolet/tahoe:Tahoe',
      'chevrolet/trailblazer:Trailblazer',
      'chevrolet/epica:Epica',
      'chevrolet/labo:Labo',
      'chevrolet/nexia-1:Nexia 1',
      'chevrolet/tacuma:Tacuma',
      'chevrolet/cruze:Cruze',
      'ravon/r4-cobalt:R4 (Cobalt)',
      'ssangyong/torres:Torres',
      'ssangyong/rexton:Rexton',
      'ssangyong/korando:Korando',
      'ssangyong/musso:Musso',
      'skoda/kodiaq:Kodiaq',
      'genesis/g90:G90',
    ]);
  });

  // Garage fitment matches by NAME, so a respelled name silently drops parts.
  it('spells every make and model exactly as the seller bot or the dealer import does', () => {
    const DEALER_CODES: Record<string, string> = {
      epica: 'EPICA',
      'nexia-1': 'NEXIA-1',
      tacuma: 'TACUMA',
      torres: 'TORRES',
      rexton: 'REXTON',
      korando: 'KORANDO',
      musso: 'MUSSO',
      g90: 'G90',
    };
    const makeName = (id: string) =>
      REFERENCE_NEW_MAKES.find((m) => m.id === id)?.name ??
      PROD.makes.find((m) => m.id === id)?.name ??
      '';

    for (const m of REFERENCE_NEW_MAKES) {
      const inBot = WIZARD_BRANDS.some((b) => b.name === m.name);
      const inDealer = resolveMake(m.name.toUpperCase())?.make === m.name;
      expect({ make: m.id, matches: inBot || inDealer }).toEqual({
        make: m.id,
        matches: true,
      });
    }
    for (const m of REFERENCE_NEW_MODELS) {
      const make = makeName(m.makeId);
      const inBot = WIZARD_BRANDS.find((b) => b.name === make)?.models.includes(
        m.name,
      );
      const code = DEALER_CODES[m.id];
      const inDealer = code
        ? resolveModel(make, code)?.model === m.name
        : false;
      expect({ model: m.id, matches: Boolean(inBot || inDealer) }).toEqual({
        model: m.id,
        matches: true,
      });
    }
  });

  it('keys each model by the slug of its name, except chevrolet-matiz (matiz is Daewoo’s)', () => {
    const slug = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    expect(
      REFERENCE_NEW_MODELS.filter((m) => m.id !== slug(m.name)).map(
        (m) => m.id,
      ),
    ).toEqual(['chevrolet-matiz']);
    expect(PROD.models.find((m) => m.id === 'matiz')?.makeId).toBe('daewoo');
  });

  it('changes the visibility of leapmotor only, and only to inactive', () => {
    expect(REFERENCE_MAKE_STATE_CHANGES).toEqual([
      expect.objectContaining({
        makeId: 'leapmotor',
        isActive: false,
        requireNoModels: true,
      }),
    ]);
  });
});

describe('plan against the 2026-09-25 production snapshot', () => {
  it('adds 4 makes and 17 models and disables leapmotor, with no conflicts or errors', () => {
    const p = plan();
    expect(p.errors).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.newMakes.map((m) => m.id)).toEqual([
      'ravon',
      'ssangyong',
      'skoda',
      'genesis',
    ]);
    expect(p.newModels).toHaveLength(17);
    expect(p.stateChanges).toEqual([
      expect.objectContaining({ makeId: 'leapmotor', from: true, to: false }),
    ]);
  });

  it('appends after the existing order instead of re-sorting it', () => {
    const p = plan();
    const sortOf = (id: string) =>
      p.newModels.find((m) => m.id === id)?.sortOrder;
    expect(sortOf('chevrolet-matiz')).toBe(15); // Chevrolet's max is 14
    expect(sortOf('cruze')).toBe(24);
    expect(sortOf('r4-cobalt')).toBe(1);
    expect(sortOf('korando')).toBe(3);
    expect(p.newMakes.map((m) => m.sortOrder)).toEqual([12, 13, 14, 15]); // makes' max is 11
  });

  it('leaves every existing row out of the write set', () => {
    expect(plan().untouched).toEqual({ makes: 11, models: PROD.models.length });
  });

  it('reports the two "Tracker" rows without touching either', () => {
    const p = plan();
    expect(p.duplicateNames).toEqual([
      'chevrolet: "Tracker" → tracker-2, tracker',
    ]);
    expect(p.newModels.some((m) => m.id.startsWith('tracker'))).toBe(false);
  });
});

describe('plan safety', () => {
  it('fails when a model id belongs to another make (bare "matiz" is Daewoo’s)', () => {
    const p = plan(PROD, only({ models: [chevy('matiz', 'Matiz')] }));
    expect(p.errors).toEqual([
      expect.stringContaining('"matiz" already belongs to make "daewoo"'),
    ]);
    expect(p.newModels).toEqual([]);
    expect(isBlocked(p)).toBe(true);
  });

  it('never renames: an existing id under another name is a conflict', () => {
    const p = plan(PROD, only({ models: [chevy('genrta-lacetti', 'Gentra')] }));
    expect(p.conflicts).toEqual([
      expect.stringContaining('"genrta-lacetti" is named "Genrta"'),
    ]);
    expect(isBlocked(p)).toBe(true);
  });

  it('never duplicates: the same name under another id in the make is a conflict', () => {
    const p = plan(PROD, only({ models: [chevy('orlando-2', 'orlando')] }));
    expect(p.conflicts).toEqual([
      expect.stringContaining('already has "Orlando" as "orlando"'),
    ]);
  });

  it('fails on duplicate or malformed input', () => {
    const p = plan(
      PROD,
      only({
        models: [
          chevy('equinox', 'Equinox'),
          chevy('equinox', 'Equinox LT'),
          chevy('Bad Id', ' Tahoe'),
        ],
      }),
    );
    expect(p.errors).toEqual(
      expect.arrayContaining([
        'model id "equinox" appears twice in the dataset',
        expect.stringContaining('"Bad Id" is not a lowercase slug'),
        expect.stringContaining('name " Tahoe" is blank, padded'),
      ]),
    );
    expect(isBlocked(p)).toBe(true);
  });

  it('does not re-activate a make that exists but is inactive', () => {
    const p = plan(
      PROD,
      only({ makes: [{ id: 'kia', name: 'Kia', evidence: 'test' }] }),
    );
    expect(p.conflicts).toEqual([
      expect.stringContaining('"kia" already exists but is inactive'),
    ]);
  });

  it('does not create a second make with an existing name', () => {
    const p = plan(
      PROD,
      only({ makes: [{ id: 'kia-motors', name: 'KIA', evidence: 'test' }] }),
    );
    expect(p.conflicts).toEqual([
      expect.stringContaining('"KIA" already exists as id "kia"'),
    ]);
  });

  it('refuses to disable leapmotor once it has models', () => {
    const snap = cloneSnapshot(PROD);
    snap.models.push({
      id: 'c10',
      makeId: 'leapmotor',
      name: 'C10',
      sortOrder: 0,
    });
    const p = plan(snap);
    expect(p.stateChanges).toEqual([]);
    expect(p.conflicts).toEqual([
      expect.stringContaining('"leapmotor" now has 1 model(s)'),
    ]);
  });

  it('never changes is_active of other makes, even empty active ones', () => {
    const snap = cloneSnapshot(PROD);
    snap.makes.push(referenceMake('geely', 'Geely', 12, true));
    expect(plan(snap).stateChanges.map((c) => c.makeId)).toEqual(['leapmotor']);
  });

  it('fails when a model names a make that exists nowhere', () => {
    const p = plan(
      PROD,
      only({
        models: [{ id: 'x5', makeId: 'bmw', name: 'X5', evidence: 'test' }],
      }),
    );
    expect(p.errors).toEqual([
      expect.stringContaining('make "bmw" is neither'),
    ]);
  });
});
