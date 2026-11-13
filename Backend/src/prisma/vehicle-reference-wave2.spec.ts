import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeReferenceDb } from '../../test/utils/vehicle-reference-fixture';
import {
  WAVE2_HELD,
  WAVE2_MODELS,
} from './seed-data/vehicle-reference-wave2.seed';
import {
  REFERENCE_DATASETS,
  WAVE1_DATASET,
  WAVE2_DATASET,
} from './vehicle-reference-datasets';
import {
  isBlocked,
  isNoop,
  planVehicleReferenceSeed,
  VEHICLE_REFERENCE_DATASET,
} from './vehicle-reference-plan';
import { isVehicleBodyType } from './vehicle-body-types';
import { formatVehicleReferenceReport } from './vehicle-reference-report';
import {
  referenceCacheKeys,
  runVehicleReferenceSeed,
} from './vehicle-reference-seed';
import { parseReferenceSnapshot } from './vehicle-reference-snapshot';

/** The real production snapshot, 2026-11-13T09:42:21Z (after Wave 1). */
const { snapshot: PROD } = parseReferenceSnapshot(
  readFileSync(
    join(
      __dirname,
      '../../test/fixtures/vehicle-reference-snapshot-2026-11-13.json',
    ),
    'utf8',
  ),
);
const TODAY = new Date('2026-11-13T12:00:00Z');
const plan = (dataset = WAVE2_DATASET) =>
  planVehicleReferenceSeed(dataset, PROD, { today: TODAY });

/**
 * Every make/model name dealer inventory is listed under (production report
 * 2026-11-13, sections 8 and 10), with its part count.
 */
const INVENTORY_NAMES: [string, string, number][] = [
  ['Chevrolet', 'Lacetti', 362],
  ['Chevrolet', 'Damas', 338],
  ['Chevrolet', 'Cobalt', 316],
  ['Chevrolet', 'Nexia 2', 238],
  ['Chevrolet', 'Spark', 208],
  ['Chevrolet', 'Tracker', 204],
  ['Chevrolet', 'Matiz', 201],
  ['Chevrolet', 'Malibu', 192],
  ['Chevrolet', 'Nexia 3', 167],
  ['Chevrolet', 'Captiva', 149],
  ['Chevrolet', 'Labo', 76],
  ['Chevrolet', 'Equinox', 45],
  ['SsangYong', 'Rexton', 42],
  ['Chevrolet', 'Onix', 41],
  ['Chevrolet', 'Orlando', 39],
  ['Chevrolet', 'Trailblazer', 35],
  ['SsangYong', 'Torres', 34],
  ['Chevrolet', 'Epica', 33],
  ['Chevrolet', 'Tahoe', 29],
  ['Chevrolet', 'Traverse', 29],
  ['Volkswagen', 'Caddy', 21],
  ['SsangYong', 'Musso', 15],
  ['Chevrolet', 'Gentra', 13],
  ['Chevrolet', 'Tacuma', 11],
  ['Chevrolet', 'Nexia 1', 9],
  ['SsangYong', 'Tivoli', 8],
  ['Skoda', 'Kodiaq', 6],
  ['Daewoo', 'Tico', 2],
  ['Hyundai', 'Santa Fe', 1],
  ['Lada', 'Largus', 1],
];

const key = (s: string) => s.trim().toLowerCase();
const makeIdOf = (makeName: string) =>
  PROD.makes.find((m) => key(m.name) === key(makeName))?.id;
const existingRow = (makeName: string, modelName: string) =>
  PROD.models.find(
    (m) => m.makeId === makeIdOf(makeName) && key(m.name) === key(modelName),
  );

describe('Wave 2 dataset', () => {
  it('is registered next to G-2 and Wave 1, with the Wave 1 policy', () => {
    expect(REFERENCE_DATASETS['wave-2']).toBe(WAVE2_DATASET);
    expect(WAVE2_DATASET.policy).toEqual(WAVE1_DATASET.policy);
    expect(WAVE2_DATASET.makes).toEqual([]);
    expect(WAVE2_DATASET.makeStateChanges).toEqual([]);
  });

  it('imports only Hyundai Santa Fe, spelled as dealer inventory spells it', () => {
    expect(WAVE2_MODELS.map((m) => `${m.makeId}/${m.id}:${m.name}`)).toEqual([
      'hyundai/hyundai-santa-fe:Santa Fe',
    ]);
    expect(INVENTORY_NAMES).toContainEqual(['Hyundai', 'Santa Fe', 1]);
  });

  it('cites only the official Hyundai Uzbekistan distributor for every imported fact', () => {
    for (const m of WAVE2_MODELS) {
      const urls = [
        ...(m.availability ?? []).map((s) => s.url),
        ...[m.bodyType, m.yearFrom, m.yearTo]
          .filter((f) => f !== undefined)
          .map((f) => f.source.url),
      ];
      expect(urls.map((u) => new URL(u).hostname)).toEqual(
        urls.map(() => 'hyundai.uz'),
      );
      expect(m.yearFrom).toBeUndefined();
      expect(m.yearTo).toBeUndefined();
    }
  });

  it('accounts for every inventory name: an existing row, an import, or a held candidate', () => {
    const imported = new Set(
      WAVE2_MODELS.map((m) => `${m.makeId}/${key(m.name)}`),
    );
    const held = new Set(WAVE2_HELD.map((h) => `${h.makeId}/${key(h.name)}`));
    const unaccounted = INVENTORY_NAMES.filter(([make, model]) => {
      const id = `${makeIdOf(make)}/${key(model)}`;
      return !existingRow(make, model) && !imported.has(id) && !held.has(id);
    });
    expect(unaccounted).toEqual([]);
  });

  it('holds exactly the inventory names that have no official Uzbekistan source', () => {
    expect(WAVE2_HELD.map((h) => `${h.makeId}:${h.name}`)).toEqual([
      'ssangyong:Tivoli',
      'lada:Largus',
    ]);
    for (const h of WAVE2_HELD) {
      expect(
        existingRow(h.makeId === 'ssangyong' ? 'SsangYong' : 'Lada', h.name),
      ).toBeUndefined();
    }
  });
});

describe('plans against the real 2026-11-13 production snapshot', () => {
  it('Wave 2 adds Santa Fe after Hyundai’s rows, as an SUV with no years', () => {
    const p = plan();
    expect(p.errors).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.newMakes).toEqual([]);
    expect(p.stateChanges).toEqual([]);
    expect(p.preservedFacts).toEqual([]);
    expect(p.newModels).toEqual([
      expect.objectContaining({
        id: 'hyundai-santa-fe',
        makeId: 'hyundai',
        name: 'Santa Fe',
        sortOrder: 23, // Hyundai's rows: Sonata 20, Tucson 21, Creta 22
        bodyType: 'SUV',
        yearFrom: null,
        yearTo: null,
      }),
    ]);
    expect(p.untouched).toEqual({ makes: 16, models: 65 });
  });

  it('Wave 1 is applied: nothing to write, and the pre-decision "suv" on suburban is reported, never rewritten', () => {
    const p = plan(WAVE1_DATASET);
    expect(isBlocked(p)).toBe(false);
    expect(isNoop(p)).toBe(true);
    expect(p.unchangedModels).toEqual(['suburban']);
    expect(p.preservedFacts).toEqual([
      'model "suburban": bodyType stays "suv"; the dataset\'s "SUV" is not written to an existing row',
    ]);
  });

  it('every body type already in production is in the vocabulary, except the pre-decision "suv"', () => {
    const outside = PROD.models
      .map((m) => m.bodyType)
      .filter((b): b is string => b !== null && b !== undefined)
      .filter((b) => !isVehicleBodyType(b));
    expect([...new Set(outside)]).toEqual(['suv']);
  });

  it('G-2 stays blocked (inactive makes), so it can never re-touch them', () => {
    expect(isBlocked(plan(VEHICLE_REFERENCE_DATASET))).toBe(true);
  });

  it('prints the blocker and the held candidates in the dry-run', () => {
    const report = formatVehicleReferenceReport(plan(), {
      outcome: 'dry-run',
      target: 'snapshot',
    });
    for (const line of [
      'Wave 2 vehicle reference seed: DRY-RUN',
      'Held back, not planned (2)',
      '? ssangyong   Tivoli',
      '? lada        Largus',
      'BLOCKER (fitment, not changed here)',
      'Summary: +0 makes, +1 models, 0 make-state change(s)',
      'Result: dry-run OK',
    ]) {
      expect(report).toContain(line);
    }
  });
});

describe('Wave 2 apply on the real snapshot (in-memory database)', () => {
  it('creates one row and leaves every existing row, Nexia generation rows included, identical', async () => {
    const { prisma, writes, state } = fakeReferenceDb(PROD);
    const { applied, plan: p } = await runVehicleReferenceSeed(prisma, {
      apply: true,
      dataset: WAVE2_DATASET,
      today: TODAY,
    });
    expect(applied).toBe(true);
    expect(writes).toEqual(['create model hyundai-santa-fe']);
    expect(state().makes).toEqual(PROD.makes);
    const existing = new Set(PROD.models.map((m) => m.id));
    expect(state().models.filter((m) => existing.has(m.id))).toEqual(
      PROD.models,
    );
    expect(state().makes.find((m) => m.id === 'hyundai')?.isActive).toBe(false);
    expect(referenceCacheKeys(p)).toEqual([
      'cache:reference:makes',
      'cache:reference:models:hyundai',
    ]);

    const again = await runVehicleReferenceSeed(prisma, {
      apply: true,
      dataset: WAVE2_DATASET,
      today: TODAY,
    });
    expect(again.applied).toBe(false);
    expect(writes).toHaveLength(1);
  });
});
