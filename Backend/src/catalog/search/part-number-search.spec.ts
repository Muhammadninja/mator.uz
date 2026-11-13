/**
 * Wave 5: buyer search by part number, end to end over an in-memory catalogue.
 *
 * The listing (GET /v1/catalog/parts?q=), POST /v1/search and the typeahead run
 * their REAL predicates over the rows below (where-eval) through the shared
 * catalogue double: count, the page (where / orderBy / skip / take) and the
 * facets. Logic-level, no PostgreSQL.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PartsService } from '../parts/parts.service';
import { SearchService } from './search.service';
import {
  CATALOGUE,
  CatalogueRow,
  NO_DISCOUNTS,
  catalogPrisma,
} from '../parts/brand-catalogue.test-util';
import * as fx from '../compatibility/fitment-fixtures.test-util';
import { ListPartsQueryDto } from '../parts/dto/list-parts.query.dto';

const OWNER = 'usr_owner';
const base = CATALOGUE[0];
let minute = 0;

/** A listed brake-pad part fitting a Cobalt, created one minute after the last. */
function row(
  id: string,
  // Loose on purpose: the shared row type infers `never[]` for its empty arrays.
  over: Record<string, unknown> & {
    fits?: [string, string][];
    curated?: string[];
  } = {},
): CatalogueRow {
  const { fits, curated, ...rest } = over;
  minute += 1;
  return {
    ...base,
    ...fx.part({ id, fits: fits ?? [['Chevrolet', 'Cobalt']], curated }),
    title: `Деталь ${id}`,
    oemNumbers: [],
    gmNumbers: [],
    createdAt: new Date(Date.UTC(2026, 9, 1) + minute * 60_000),
    ...rest,
  } as unknown as CatalogueRow;
}

// Oldest first: a later row is NEWER, so plain newest-first puts it ahead.
const ROWS: CatalogueRow[] = [
  // GM-labelled number (gm_numbers only).
  row('gm_exact', {
    gmNumbers: ['96879797'],
    partNumberType: 'GM',
    priceUzs: 150_000,
  }),
  // OEM-labelled, stored as written plus its canonical form.
  row('oem_bosch', {
    oemNumbers: ['SP-1362', 'SP1362'],
    partBrandName: 'Bosch',
  }),
  // Another manufacturer, the same canonical form: both are listed, never merged.
  row('oem_denso', {
    oemNumbers: ['SP 1362', 'SP1362'],
    partBrandName: 'Denso',
  }),
  // Driver's Village manufacturer part number (code_1c) indexed in oem_numbers.
  row('dv_bosch', { oemNumbers: ['0986452041'], partBrandName: 'Bosch' }),
  row('no_zero', { oemNumbers: ['986452041'], partBrandName: 'Bosch' }),
  row('one_digit_off', { gmNumbers: ['96879798'] }),
  // Would be an "alternative" only through a cross-reference: never by search.
  row('xref_candidate', { gmNumbers: ['96879799'] }),
  row('short_2106', { gmNumbers: ['2106'] }),
  row('short_123', { oemNumbers: ['123'] }),
  // Same number, but no photo: not listed.
  row('no_photo', { gmNumbers: ['96879797'], images: [] }),
  // Same number, fits a Spark only.
  row('spark_only', {
    gmNumbers: ['96879797'],
    fits: [['Chevrolet', 'Spark']],
  }),
  // Same number, filed under discs.
  row('disc_exact', {
    gmNumbers: ['96879797'],
    categoryId: 'brake-discs',
    category: { id: 'brake-discs' },
  }),
  // A stored spelling with Cyrillic (legacy Telegram number), no canonical form.
  row('legacy_cyr', { gmNumbers: ['ЗМЗ-406'] }),
  // Title mentions the number: newer than every exact match above.
  ...Array.from({ length: 5 }, (_, i) =>
    row(`title_${i + 1}`, {
      title: `Фильтр аналог 96879797 №${i + 1}`,
      priceUzs: 50_000 + i,
    }),
  ),
  row('title_vaz', { title: 'Прокладка ВАЗ 2106' }),
];

function prismaFor(rows = ROWS) {
  const prisma = catalogPrisma(rows);
  return {
    ...prisma,
    vehicle: {
      findFirst: ({ where }: { where: { userId?: string } }) =>
        Promise.resolve(
          where.userId === OWNER ? fx.vehicleRow(fx.VEHICLES.cobalt) : null,
        ),
    },
  };
}

async function list(
  query: Partial<ListPartsQueryDto>,
  userId: string | null = null,
) {
  const prisma = prismaFor();
  const svc = new PartsService(prisma as never, NO_DISCOUNTS as never);
  const res = await svc.list(query, 'ru', userId);
  return { ids: res.items.map((p: { id: string }) => p.id), res };
}

async function allPages(query: Partial<ListPartsQueryDto>, pageSize: number) {
  const ids: string[] = [];
  let total = -1;
  for (let page = 1; page < 50; page += 1) {
    const { ids: got, res } = await list({
      ...query,
      page,
      page_size: pageSize,
    });
    total = res.total;
    ids.push(...got);
    if (res.next_page === null) break;
  }
  return { ids, total };
}

const EXACT_96879797 = ['disc_exact', 'spark_only', 'gm_exact']; // newest first
const TITLE_96879797 = ['title_5', 'title_4', 'title_3', 'title_2', 'title_1'];

describe('exact part-number lookup', () => {
  it('GM number: every listed part carrying it, exact matches before title matches', async () => {
    const { ids } = await list({ q: '96879797', page_size: 50 });
    expect(ids).toEqual([...EXACT_96879797, ...TITLE_96879797]);
  });

  it('OEM number, however it is typed', async () => {
    for (const q of ['SP-1362', 'sp-1362', 'SP 1362', 'sp1362']) {
      const { ids } = await list({ q, page_size: 50 });
      expect([...ids].sort()).toEqual(['oem_bosch', 'oem_denso']);
    }
  });

  it('the stored spelling typed exactly ranks first; a format variant follows', async () => {
    // oem_denso stores "SP 1362" (the literal), oem_bosch "SP-1362".
    expect((await list({ q: 'SP 1362' })).ids).toEqual([
      'oem_denso',
      'oem_bosch',
    ]);
    expect((await list({ q: 'SP-1362' })).ids).toEqual([
      'oem_bosch',
      'oem_denso',
    ]);
  });

  it("manufacturer (Driver's Village) part number", async () => {
    expect((await list({ q: '0986452041' })).ids).toEqual(['dv_bosch']);
    expect((await list({ q: '0986 452 041' })).ids).toEqual(['dv_bosch']);
  });

  it('a leading zero is part of the number', async () => {
    expect((await list({ q: '0986452041' })).ids).not.toContain('no_zero');
    expect((await list({ q: '986452041' })).ids).toEqual(['no_zero']);
  });

  it('a number one digit off is not a match', async () => {
    const { ids } = await list({ q: '96879797', page_size: 50 });
    expect(ids).not.toContain('one_digit_off');
    expect((await list({ q: '96879798' })).ids).toEqual(['one_digit_off']);
  });

  it('a legacy spelling with Cyrillic is found when typed exactly', async () => {
    expect((await list({ q: 'ЗМЗ-406' })).ids).toEqual(['legacy_cyr']);
  });
});

describe('incorrect identifiers are rejected', () => {
  it('"ВАЗ 2106" is a title search, not number 2106', async () => {
    expect((await list({ q: 'ВАЗ 2106' })).ids).toEqual(['title_vaz']);
  });

  it('a Cyrillic look-alike "А123" does not become number 123', async () => {
    expect((await list({ q: 'А123' })).ids).toEqual([]);
  });

  it('no prefix match: part of a number finds nothing by number', async () => {
    expect((await list({ q: '9687979' })).ids).toEqual(TITLE_96879797);
  });

  it('a long number beside words is still looked up exactly', async () => {
    const { ids } = await list({ q: 'фильтр 96879797', page_size: 50 });
    expect(ids).toEqual(EXACT_96879797);
  });
});

describe('a plain title search is untouched', () => {
  it('"масляный фильтр": one page read, title-only predicate, newest first — as before Wave 5', async () => {
    const prisma = prismaFor([
      ...ROWS,
      row('oil_a', { title: 'Масляный фильтр Nexia' }),
      row('oil_b', { title: 'Масляный фильтр Cobalt' }),
    ]);
    const findMany = jest.spyOn(prisma.catalogPart, 'findMany');
    const count = jest.spyOn(prisma.catalogPart, 'count');
    const svc = new PartsService(prisma as never, NO_DISCOUNTS as never);
    const res = await svc.list({ q: 'масляный фильтр' });

    expect(res.items.map((p: { id: string }) => p.id)).toEqual([
      'oil_b',
      'oil_a',
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(1);
    const { where, orderBy } = findMany.mock.calls[0][0] as {
      where: { AND: unknown[] };
      orderBy: unknown;
    };
    // The pre-Wave-5 text clause for a word: the title, nothing else.
    expect(where.AND).toContainEqual({
      OR: [{ title: { contains: 'масляный фильтр', mode: 'insensitive' } }],
    });
    expect(orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });
});

describe('ranking, sorting and pagination', () => {
  it('an explicit sort is kept as chosen: price ascending ignores the tiers', async () => {
    const { ids } = await list({
      q: '96879797',
      sort: 'price_asc',
      page_size: 3,
    });
    expect(ids).toEqual(['title_1', 'title_2', 'title_3']);
  });

  it('"relevance" ranks like no sort', async () => {
    const a = await list({ q: '96879797', page_size: 50 });
    const b = await list({ q: '96879797', sort: 'relevance', page_size: 50 });
    expect(b.ids).toEqual(a.ids);
  });

  it.each([1, 2, 3, 4])(
    'pages of %i: no row twice, none lost, total unchanged',
    async (size) => {
      const { ids, total } = await allPages({ q: '96879797' }, size);
      expect(ids).toEqual([...EXACT_96879797, ...TITLE_96879797]);
      expect(total).toBe(ids.length);
    },
  );

  it('category filter: only the parts filed under it', async () => {
    const { ids, res } = await list({ q: '96879797', category: 'brake-discs' });
    expect(ids).toEqual(['disc_exact']);
    expect(res.total).toBe(1);
  });
});

describe('buyer catalog rules stay in force', () => {
  it('a part without a photo is never listed, even on an exact number', async () => {
    const { ids } = await list({ q: '96879797', page_size: 50 });
    expect(ids).not.toContain('no_photo');
  });

  it('garage vehicle: only parts that fit it, ranked exact first', async () => {
    const { ids } = await list(
      { q: '96879797', vehicle_id: 'veh_1', page_size: 50 },
      OWNER,
    );
    expect(ids).toEqual(['disc_exact', 'gm_exact', ...TITLE_96879797]);
    expect(ids).not.toContain('spark_only');
  });

  it('garage vehicle: the search adds nothing to what the vehicle listing allows', async () => {
    const all = await list({ vehicle_id: 'veh_1', page_size: 100 }, OWNER);
    const searched = await list(
      { q: '96879797', vehicle_id: 'veh_1', page_size: 100 },
      OWNER,
    );
    for (const id of searched.ids) expect(all.ids).toContain(id);
  });

  it("the page still carries each part's own compatibility, unchanged by search", async () => {
    const plain = await list({ vehicle_id: 'veh_1', page_size: 100 }, OWNER);
    const searched = await list({ q: '96879797', vehicle_id: 'veh_1' }, OWNER);
    const byId = (items: { id: string }[]) =>
      new Map(items.map((p) => [p.id, JSON.stringify(p)]));
    const before = byId(plain.res.items);
    for (const item of searched.res.items) {
      expect(JSON.stringify(item)).toBe(before.get(item.id));
    }
  });
});

describe('unverified cross-references are never a search result', () => {
  it('a part related only through another number is not listed', async () => {
    const { ids } = await list({ q: '96879797', page_size: 50 });
    expect(ids).not.toContain('xref_candidate');
  });

  it('the search code reads no cross-reference or OEM-fitment data', () => {
    for (const file of [
      'part-relevance.ts',
      'search.service.ts',
      '../parts/parts.service.ts',
      '../../ai-chat/rag-search.service.ts',
    ]) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      // `.` for the dash: Wave 4's own guard flags any file spelling its path.
      expect(src).not.toMatch(/oem.xref|oemCompatibility|oem_compatibility/);
    }
  });
});

describe('POST /v1/search and the typeahead rank the same way', () => {
  const searchSvc = () =>
    new SearchService(prismaFor() as never, NO_DISCOUNTS as never);

  it('search: exact matches first, total and pages consistent', async () => {
    const svc = searchSvc();
    const first = await svc.search({ query: '96879797', limit: 4 }, 'ru');
    expect(first.results.map((r) => r.id)).toEqual([
      ...EXACT_96879797,
      'title_5',
    ]);
    expect(first.total).toBe(8);
    const second = await svc.search(
      { query: '96879797', limit: 4, pageToken: first.nextPageToken },
      'ru',
    );
    expect(second.results.map((r) => r.id)).toEqual([
      'title_4',
      'title_3',
      'title_2',
      'title_1',
    ]);
    expect(second.nextPageToken).toBeNull();
  });

  it('search: the response keeps its shape (no new fields)', async () => {
    const res = await searchSvc().search({ query: '96879797' }, 'ru');
    expect(Object.keys(res).sort()).toEqual(
      [
        'appliedFilters',
        'categories',
        'didYouMean',
        'durationMs',
        'facetCounts',
        'nextPageToken',
        'requestId',
        'results',
        'suggestedCategories',
        'total',
      ].sort(),
    );
    expect(Object.keys(res.results[0]).sort()).toEqual(
      ['category', 'category_id', 'id', 'price', 'title'].sort(),
    );
  });

  it('typeahead: exact matches lead the product suggestions', async () => {
    const res = await searchSvc().typeahead('96879797', 5);
    expect(res.suggestions.map((s) => s.type)).toEqual([
      'query',
      'product',
      'product',
      'product',
      'product',
    ]);
    expect(res.suggestions.slice(1).map((s) => s.deeplink)).toEqual([
      '/(tabs)/(explore)/item-detail/disc_exact',
      '/(tabs)/(explore)/item-detail/spark_only',
      '/(tabs)/(explore)/item-detail/gm_exact',
      '/(tabs)/(explore)/item-detail/title_5',
    ]);
  });

  it('typeahead: a word is a title search only', async () => {
    const res = await searchSvc().typeahead('Прокладка', 5);
    expect(res.suggestions.slice(1).map((s) => s.text)).toEqual([
      'Прокладка ВАЗ 2106',
    ]);
  });
});
