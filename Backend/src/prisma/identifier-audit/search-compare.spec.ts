import { parseAuditSnapshot } from './identifier-audit.snapshot';
import {
  compareQuery,
  compareSearch,
  formatSearchComparison,
  generateQueries,
} from './search-compare';

let minute = 0;
function part(id: string, title: string, over: Record<string, unknown> = {}) {
  minute += 1;
  return {
    id,
    title,
    part_brand_name: null,
    brand_name: null,
    part_number_type: 'UNKNOWN',
    gm_numbers: [],
    oem_numbers: [],
    is_universal: false,
    // Later rows are newer: newest first lists them first.
    created_at: new Date(Date.UTC(2026, 9, 1) + minute * 60_000).toISOString(),
    listed: true,
    has_fitment: true,
    source_part_number: null,
    source_system: null,
    ...over,
  };
}

const SNAPSHOT = parseAuditSnapshot(
  JSON.stringify({
    kind: 'catalog-identifier-audit',
    format_version: 1,
    captured_at: '2026-11-13T00:00:00Z',
    database: 'fixture',
    parts: [
      part('gm_exact', 'Элемент масляного фильтра', {
        gm_numbers: ['96879797'],
      }),
      part('short_123', 'Прокладка клапанной крышки', { oem_numbers: ['123'] }),
      part('short_2106', 'Сальник коленвала', { gm_numbers: ['2106'] }),
      part('oil_1', 'Масляный фильтр Nexia'),
      part('oil_2', 'Масляный фильтр Cobalt 96879797'),
      part('oil_3', 'Масляный фильтр Lacetti'),
      part('vaz', 'Прокладка ВАЗ 2106'),
      part('hidden', 'Масляный фильтр Spark', { listed: false }),
    ],
  }),
);
const listed = SNAPSHOT.parts.filter((p) => p.listed);
const cmp = (text: string) =>
  compareQuery(listed, { text, source: 'file' }, 20);

describe('search before vs after Wave 5', () => {
  it('a title search is unchanged: same parts, same order ("масляный фильтр")', () => {
    const c = cmp('масляный фильтр');
    expect(c.status).toBe('identical');
    expect(c.after).toEqual(['oil_3', 'oil_2', 'oil_1']);
  });

  it('an exact number now leads; nothing gained or lost', () => {
    const c = cmp('96879797');
    expect(c.status).toBe('reordered');
    expect(c.before).toEqual(['oil_2', 'gm_exact']);
    expect(c.after).toEqual(['gm_exact', 'oil_2']);
  });

  it('a short number typed alone is still found', () => {
    expect(cmp('2106').after[0]).toBe('short_2106');
    expect(cmp('123').after).toEqual(['short_123']);
  });

  it('a short number beside words is no longer looked up — and the report shows it', () => {
    const c = cmp('ВАЗ 2106');
    expect(c.lost).toEqual(['short_2106']);
    expect(c.after).toEqual(['vaz']);
    expect(cmp('сальник 2106').lost).toEqual(['short_2106']);
  });

  it('a long number beside words is still found', () => {
    expect(cmp('фильтр 96879797').after).toEqual(['gm_exact']);
  });

  it('hidden parts are left out on both sides', () => {
    expect(cmp('масляный фильтр spark').before).toEqual([]);
  });
});

describe('generated queries and the report', () => {
  const queries = generateQueries(SNAPSHOT);

  it('derives number, short-number and title queries from listed parts only', () => {
    const texts = (source: string) =>
      queries.filter((q) => q.source === source).map((q) => q.text);
    expect(texts('number_as_stored').sort()).toEqual([
      '123',
      '2106',
      '96879797',
    ]);
    expect(texts('short_number_beside_word').sort()).toEqual([
      'прокладка 123',
      'сальник 2106',
    ]);
    expect(texts('title_words')).toContain('масляный фильтр');
    expect(queries.some((q) => q.text.includes('spark'))).toBe(false);
  });

  it('summarizes per source: title words identical, short numbers beside words lost', () => {
    const res = compareSearch(SNAPSHOT, queries);
    const by = Object.fromEntries(res.summaries.map((s) => [s.source, s]));
    expect(by.title_words.changed).toBe(0);
    expect(by.short_number_beside_word.withLost).toBe(2);
    const text = formatSearchComparison(res, 'fixture');
    expect(text).toContain('READ-ONLY, nothing was changed');
    expect(text).toContain('"сальник 2106" [changed]; lost short_2106');
  });
});
