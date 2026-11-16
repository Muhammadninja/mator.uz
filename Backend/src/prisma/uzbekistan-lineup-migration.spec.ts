// Guards migration 20261125000000_uzbekistan_lineup_models against the
// production catalog snapshot: every new model belongs to an existing make, its
// id is free in the one global model key space, and it does not duplicate a
// model name its make already has.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = { id: string; make_id: string; name: string };
const snapshot = JSON.parse(
  readFileSync(join(__dirname, '../../test/fixtures/vehicle-reference-snapshot-2026-11-13.json'), 'utf8'),
) as { makes: { id: string }[]; models: Row[] };
const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20261125000000_uzbekistan_lineup_models/migration.sql'),
  'utf8',
);
const inserted = [...sql.matchAll(/SELECT '([^']+)', '([^']+)', '([^']+)',/g)].map(
  ([, id, make_id, name]) => ({ id, make_id, name }),
);

describe('Uzbekistan lineup migration', () => {
  it('adds the official models it documents', () => {
    expect(inserted).toHaveLength(34);
    expect(inserted.map((r) => r.id)).toEqual(expect.arrayContaining(['byd-ti-7', 'teramont-x', 'kia-sorento', 'toyota-camry']));
  });

  it('only targets makes the catalog already has', () => {
    const makes = new Set(snapshot.makes.map((m) => m.id));
    expect(inserted.filter((r) => !makes.has(r.make_id))).toEqual([]);
  });

  it('never reuses a model id, in the snapshot or within the migration', () => {
    const taken = new Set(snapshot.models.map((m) => m.id));
    expect(inserted.filter((r) => taken.has(r.id))).toEqual([]);
    expect(new Set(inserted.map((r) => r.id)).size).toBe(inserted.length);
  });

  it('never adds a name its make already has', () => {
    const names = new Set(snapshot.models.map((m) => `${m.make_id}:${m.name.toLowerCase()}`));
    expect(inserted.filter((r) => names.has(`${r.make_id}:${r.name.toLowerCase()}`))).toEqual([]);
  });

  it('is guarded so a re-run or an operator-added row changes nothing', () => {
    const blocks = sql.split('INSERT INTO').slice(1);
    for (const block of blocks) {
      expect(block).toContain('WHERE EXISTS (SELECT 1 FROM "vehicle_makes"');
      expect(block).toContain('AND NOT EXISTS (SELECT 1 FROM "vehicle_models" WHERE "id"');
      expect(block).toContain('lower("name") = lower(');
    }
  });
});
