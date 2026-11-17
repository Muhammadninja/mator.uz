// Guards migration 20261130000000: it fills only the start year of the five
// Chevrolet rows 20261124000000 held back, and never overwrites operator data.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20261130000000_held_vehicle_model_year_ranges/migration.sql'),
  'utf8',
);
const blocks = sql.split('UPDATE "vehicle_models"').slice(1);
const starts = new Map<string, number>();
for (const b of blocks) {
  const from = Number(/"year_from" = (\d+)/.exec(b)?.[1]);
  const ids = /"id" (?:= '([^']+)'|IN \(([^)]+)\))/.exec(b)!;
  const list = ids[1] ? [ids[1]] : ids[2].split(',').map((s) => s.trim().replace(/'/g, ''));
  for (const id of list) starts.set(id, from);
}

describe('held Chevrolet model years migration', () => {
  it('starts damas/labo 1991, spark 2005, both Trackers 2013', () => {
    expect(Object.fromEntries(starts)).toEqual({
      damas: 1991, labo: 1991, spark: 2005, tracker: 2013, 'tracker-2': 2013,
    });
  });

  it('touches only Chevrolet base rows with no start, and never year_to', () => {
    for (const b of blocks) {
      expect(b).toContain('AND "make_id" = \'chevrolet\'');
      expect(b).toContain('AND "variant_of_model_id" IS NULL');
      expect(b).toContain('AND "year_from" IS NULL');
      expect(b).not.toMatch(/SET[^;]*"year_to"/);
    }
  });
});
