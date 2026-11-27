/**
 * searchTier (in memory) must decide exactly what partTextWhere + relevanceTiers
 * (the Prisma predicate) decide: the offline search comparison relies on it.
 */
import { matchesWhere } from '../compatibility/where-eval.test-util';
import {
  numberPrefixKey,
  partTextWhere,
  prefixIdsIn,
  relevanceTiers,
  searchTier,
  tieredPage,
} from './part-relevance';

const PARTS = [
  {
    id: 'gm',
    title: 'Фильтр масляный',
    gmNumbers: ['96879797'],
    oemNumbers: [],
  },
  {
    id: 'oem_dash',
    title: 'Свеча',
    gmNumbers: [],
    oemNumbers: ['SP-1362', 'SP1362'],
  },
  {
    id: 'oem_space',
    title: 'Свеча',
    gmNumbers: [],
    oemNumbers: ['SP 1362', 'SP1362'],
  },
  { id: 'zero', title: 'Колодки', gmNumbers: [], oemNumbers: ['0986452041'] },
  { id: 'short', title: 'Прокладка', gmNumbers: ['2106'], oemNumbers: [] },
  { id: 'cyr', title: 'Двигатель', gmNumbers: ['ЗМЗ-406'], oemNumbers: [] },
  {
    id: 'title_num',
    title: 'Фильтр аналог 96879797',
    gmNumbers: [],
    oemNumbers: [],
  },
  { id: 'vaz', title: 'Прокладка ВАЗ 2106', gmNumbers: [], oemNumbers: [] },
  {
    id: 'word',
    title: 'FILTER element',
    gmNumbers: [],
    oemNumbers: ['FILTER'],
  },
];

const QUERIES = [
  '96879797',
  'SP-1362',
  'sp 1362',
  'SP1362',
  '0986452041',
  '986452041',
  '2106',
  'ВАЗ 2106',
  'фильтр 96879797',
  'масляный',
  'ЗМЗ-406',
  'filter',
  'Свеча',
  '5W-30',
  '96.879.797',
  '',
  '   ',
  '%',
  'фильтр 2106',
  // Number prefixes (typed start of a stored number).
  '968',
  '9687979',
  'sp13',
  'SP-13',
  '098645',
  '21',
  '263',
];

describe('searchTier agrees with the Prisma predicate', () => {
  it.each(QUERIES)('query %j', (q) => {
    const ids = prefixIdsIn(PARTS, q);
    const tiers = relevanceTiers(q, ids);
    for (const part of PARTS) {
      const matched = matchesWhere(part, partTextWhere(q, ids));
      const tier = tiers.findIndex((t) =>
        matchesWhere(part, { AND: [partTextWhere(q, ids), t] }),
      );
      expect(searchTier(part, q, ids.length > 0)).toBe(matched ? tier : null);
    }
  });
});

describe('number prefix', () => {
  it('lists parts whose number starts with the typed digits', () => {
    expect(prefixIdsIn(PARTS, '968')).toEqual(['gm']);
    expect(prefixIdsIn(PARTS, '9687979')).toEqual(['gm']);
    expect(prefixIdsIn(PARTS, '098645')).toEqual(['zero']);
  });

  it('ignores separators on both sides', () => {
    expect(prefixIdsIn(PARTS, 'sp13').sort()).toEqual(['oem_dash', 'oem_space']);
    expect(prefixIdsIn(PARTS, 'SP-13').sort()).toEqual(['oem_dash', 'oem_space']);
  });

  it('never matches the middle or end of a number', () => {
    expect(prefixIdsIn(PARTS, '879797')).toEqual([]);
    expect(prefixIdsIn(PARTS, '986452041')).toEqual([]);
  });

  it('needs a lone number of at least 3 characters with a digit', () => {
    expect(numberPrefixKey('21')).toBeNull();
    expect(numberPrefixKey('filter')).toBeNull();
    expect(numberPrefixKey('фильтр 2106')).toBeNull();
    expect(numberPrefixKey('ЗМЗ-406')).toBeNull();
    expect(numberPrefixKey(' 263 ')).toBe('263');
    expect(numberPrefixKey('96 87')).toBe('9687');
  });

  it('ranks after an exact number and before titles', () => {
    const parts = [
      { id: 'exact', title: 'x', gmNumbers: ['2106'], oemNumbers: [] },
      { id: 'longer', title: 'y', gmNumbers: ['21065'], oemNumbers: [] },
      { id: 'title', title: 'Прокладка 2106', gmNumbers: [], oemNumbers: [] },
    ];
    const ids = prefixIdsIn(parts, '2106');
    expect(parts.map((p) => searchTier(p, '2106', ids.length > 0))).toEqual([0, 1, 2]);
  });
});

describe('relevanceTiers', () => {
  it('a plain word has one tier: nothing to rank, order untouched', () => {
    expect(relevanceTiers('масляный фильтр')).toEqual([{}]);
    expect(relevanceTiers('pads')).toEqual([{}]);
  });

  it('the tiers are disjoint and cover every match', () => {
    for (const q of QUERIES) {
      const tiers = relevanceTiers(q);
      for (const part of PARTS) {
        const hits = tiers.filter((t) =>
          matchesWhere(part, { AND: [partTextWhere(q), t] }),
        ).length;
        expect(hits).toBe(matchesWhere(part, partTextWhere(q)) ? 1 : 0);
      }
    }
  });
});

describe('tieredPage', () => {
  const rows = ['a1', 'a2', 'b1', 'b2', 'b3', 'c1'];
  const tierOf = (id: string) =>
    ({ a: 0, b: 1, c: 2 })[id[0] as 'a' | 'b' | 'c'];
  const tiers = [{ t: 0 }, { t: 1 }, { t: 2 }] as never[];
  const pick = (where: { AND?: [unknown, { t: number }] }) =>
    rows.filter((r) => !where.AND || tierOf(r) === where.AND[1].t);
  const count = jest.fn((w: never) => Promise.resolve(pick(w).length));
  const fetch = jest.fn((w: never, skip: number, take: number) =>
    Promise.resolve(pick(w).slice(skip, skip + take)),
  );

  beforeEach(() => jest.clearAllMocks());

  it('every page size and offset reads the concatenation exactly', async () => {
    for (let take = 1; take <= 7; take += 1) {
      for (let skip = 0; skip <= 7; skip += 1) {
        const got = await tieredPage(count, fetch, {}, tiers, skip, take);
        expect(got).toEqual(rows.slice(skip, skip + take));
      }
    }
  });

  it('the first page reads no counts', async () => {
    await tieredPage(count, fetch, {}, tiers, 0, 3);
    expect(count).not.toHaveBeenCalled();
  });

  it('one tier is one plain read', async () => {
    await tieredPage(count, fetch, {}, [{}], 4, 2);
    expect(count).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith({}, 4, 2);
  });
});
