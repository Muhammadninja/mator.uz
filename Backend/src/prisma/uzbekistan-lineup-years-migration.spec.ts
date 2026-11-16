// Guards migration 20261126000000: it only ranges models the lineup migration
// added, every range is sane, and every update keeps operator data.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (name: string) =>
  readFileSync(join(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');
const lineup = read('20261125000000_uzbekistan_lineup_models');
const years = read('20261126000000_uzbekistan_lineup_model_years');
const added = new Set([...lineup.matchAll(/SELECT '([^']+)', '([^']+)',/g)].map((m) => `${m[2]}:${m[1]}`));
const ranges = [
  ...years.matchAll(/"year_from" = (\d+), "year_to" = (NULL|\d+).*?\nWHERE "id" = '([^']+)'\n {2}AND "make_id" = '([^']+)'/gs),
].map(([, from, to, id, make]) => ({ key: `${make}:${id}`, from: Number(from), to: to === 'NULL' ? null : Number(to) }));

describe('Uzbekistan lineup years migration', () => {
  it('ranges 23 models, all added by the lineup migration', () => {
    expect(ranges).toHaveLength(23);
    expect(ranges.filter((r) => !added.has(r.key))).toEqual([]);
  });

  it('has sane ranges: a start before the picker\'s future, an end not before it', () => {
    for (const r of ranges) {
      expect(r.from).toBeGreaterThanOrEqual(2000);
      expect(r.from).toBeLessThanOrEqual(2026);
      if (r.to !== null) expect(r.to).toBeGreaterThanOrEqual(r.from);
    }
    expect(ranges.find((r) => r.key === 'lada:lada-xray')).toEqual({ key: 'lada:lada-xray', from: 2015, to: 2022 });
  });

  it('only fills rows whose bounds are both empty', () => {
    expect(years.split('UPDATE "vehicle_models"').slice(1).every((b) =>
      b.includes('AND "year_from" IS NULL') && b.includes('AND "year_to" IS NULL'))).toBe(true);
  });
});
