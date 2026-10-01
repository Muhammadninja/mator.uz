// filter=top300 of the part-first queue: the business TOP-300 is the ranking
// ALREADY STORED in `catalog_parts.fitment_priority` — the queue reads it, it
// never builds, recomputes or pads it.
//
// The queue's real `where` / `orderBy` are evaluated over an in-memory catalogue
// (where-eval + the PostgreSQL ordering rules below), so these tests assert
// WHICH parts come back and in WHAT order — not just the shape of the query.
// Logic-level only: no PostgreSQL is involved.

import { matchesWhere } from '../../catalog/compatibility/where-eval.test-util';
import { GetPartsQueueQueryDto } from './dto/get-parts-queue-query.dto';
import { FitmentQueueService } from './fitment-queue.service';

type Dir = 'asc' | 'desc';
type OrderRule = Dir | { sort: Dir; nulls?: 'first' | 'last' };
type OrderBy = Record<string, OrderRule>;
type Row = Record<string, unknown> & { id: string };

/**
 * Sort like PostgreSQL: ASC puts NULLs last and DESC first unless `nulls`
 * says otherwise. Throws when the orderBy leaves two rows TIED — the database
 * would return those in an arbitrary order, so a queue relying on it is not
 * deterministic. (Ids are plain ASCII, where JS and PostgreSQL collations
 * agree.)
 */
function orderRows(rows: Row[], orderBy: OrderBy | OrderBy[]): Row[] {
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  const cmp = (a: Row, b: Row): number => {
    for (const spec of specs) {
      const entries = Object.entries(spec);
      if (entries.length !== 1) throw new Error('one field per orderBy entry');
      const [field, rule] = entries[0];
      const sort = typeof rule === 'string' ? rule : rule.sort;
      const nulls =
        (typeof rule === 'string' ? undefined : rule.nulls) ??
        (sort === 'asc' ? 'last' : 'first');
      const av = a[field];
      const bv = b[field];
      const aNull = av === null || av === undefined;
      const bNull = bv === null || bv === undefined;
      if (aNull && bNull) continue;
      if (aNull || bNull) return aNull === (nulls === 'first') ? -1 : 1;
      if (typeof av !== typeof bv || typeof av === 'object') {
        throw new Error(`unsupported orderBy value for "${field}"`);
      }
      if ((av as number | string) < (bv as number | string))
        return sort === 'asc' ? -1 : 1;
      if ((av as number | string) > (bv as number | string))
        return sort === 'asc' ? 1 : -1;
    }
    return 0;
  };
  const sorted = [...rows].sort(cmp);
  for (let i = 1; i < sorted.length; i++) {
    if (cmp(sorted[i - 1], sorted[i]) === 0) {
      throw new Error(
        `orderBy leaves ${sorted[i - 1].id} and ${sorted[i].id} tied`,
      );
    }
  }
  return sorted;
}

/** Prisma double over in-memory rows: reads evaluate, writes are recorded. */
function catalogStore(rows: Row[]) {
  const findMany = jest.fn(
    (args: {
      where?: unknown;
      orderBy?: OrderBy | OrderBy[];
      take?: number;
    }) => {
      const hit = rows.filter((r) => matchesWhere(r, args.where));
      const sorted = args.orderBy ? orderRows(hit, args.orderBy) : hit;
      return Promise.resolve(
        args.take === undefined ? sorted : sorted.slice(0, args.take),
      );
    },
  );
  const count = jest.fn((args: { where?: unknown }) =>
    Promise.resolve(rows.filter((r) => matchesWhere(r, args.where)).length),
  );
  return {
    catalogPart: {
      findMany,
      count,
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    $executeRaw: jest.fn(),
  };
}

const row = (over: Partial<Row> & { id: string }): Row => ({
  title: 'Масляный фильтр',
  images: [],
  oemNumbers: [],
  gmNumbers: [],
  isOem: false,
  fitmentPriority: null,
  salesCount: 0,
  ratingAvg: null,
  reviewCount: 0,
  isBestseller: false,
  brand: { name: 'Sangsin' },
  category: { slug: 'oil-filters', parent: { slug: 'engine' } },
  fitmentBindings: [],
  ...over,
});

const bound = (vehicleModelId: string) => [
  { vehicleModelId, node: { category: 'ENGINE' } },
];

// Every signal OTHER than the stored rank disagrees with it: the best seller,
// best rated and most reviewed parts are unranked or ranked last.
const CATALOGUE: Row[] = [
  row({
    id: 'p_d',
    salesCount: 9_999,
    ratingAvg: 5,
    reviewCount: 999,
    isBestseller: true,
  }),
  row({
    id: 'p_c',
    fitmentPriority: 2,
    salesCount: 900,
    ratingAvg: 4.9,
    reviewCount: 500,
  }),
  row({ id: 'p_a', fitmentPriority: 2, title: 'Тормозные колодки' }),
  row({
    id: 'p_e',
    fitmentPriority: 3,
    title: 'Колодки задние',
    fitmentBindings: bound('cobalt'),
  }),
  row({ id: 'p_b', fitmentPriority: 1 }),
  row({ id: 'p_f', salesCount: 50, fitmentBindings: bound('spark') }),
];

/** The stored ranking: 1 (p_b), 2 (p_a, p_c — tie broken by id), 3 (p_e). */
const TOP300_ORDER = ['p_b', 'p_a', 'p_c', 'p_e'];

async function queue(rows: Row[], over: Partial<GetPartsQueueQueryDto> = {}) {
  const prisma = catalogStore(rows);
  const res = await new FitmentQueueService(prisma as never).getPartsQueue({
    limit: 300,
    filter: 'top300',
    ...over,
  });
  return { prisma, res, ids: res.data.map((r) => r.id) };
}

describe('FitmentQueueService — filter=top300 reads the stored fitment_priority', () => {
  it('selects exactly the parts that carry a stored priority, mapped or not', async () => {
    const { ids, res } = await queue(CATALOGUE);
    expect([...ids].sort()).toEqual([...TOP300_ORDER].sort());
    expect(res.meta.total).toBe(4);
  });

  it('orders by fitmentPriority ASC: priority 1 is part #1', async () => {
    const { ids } = await queue(CATALOGUE);
    expect(ids).toEqual(TOP300_ORDER);
    const rank = new Map(CATALOGUE.map((r) => [r.id, r.fitmentPriority]));
    const priorities = ids.map((id) => rank.get(id) as number);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it('equal priorities are tie-broken by id ASC, whatever the storage order', async () => {
    // The in-memory store throws on a tie the orderBy does not break, so this
    // also proves the order never depends on how the database returns rows.
    for (const rows of [
      CATALOGUE,
      [...CATALOGUE].reverse(),
      [...CATALOGUE.slice(3), ...CATALOGUE.slice(0, 3)],
    ]) {
      expect((await queue(rows)).ids).toEqual(TOP300_ORDER);
    }
  });

  it.each(['salesCount', 'ratingAvg', 'reviewCount', 'isBestseller'])(
    '%s does not affect the order',
    async (signal) => {
      // Invert the signal across the ranked parts: the queue must not move.
      const inverted = CATALOGUE.map((r) => {
        const pos = TOP300_ORDER.indexOf(r.id);
        if (pos === -1) return r;
        const value = signal === 'isBestseller' ? pos === 3 : (pos + 1) * 1000;
        return { ...r, [signal]: value };
      });
      const { ids, prisma } = await queue(inverted);
      expect(ids).toEqual(TOP300_ORDER);
      // Nor is the signal ever part of the query.
      expect(
        JSON.stringify(prisma.catalogPart.findMany.mock.calls),
      ).not.toMatch(/salesCount|ratingAvg|reviewCount|isBestseller/);
    },
  );

  it('reads only: no priority is written or recomputed', async () => {
    const { prisma } = await queue(CATALOGUE);
    expect(prisma.catalogPart.update).not.toHaveBeenCalled();
    expect(prisma.catalogPart.updateMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('with no stored priority anywhere the tab is empty — never a fallback to other parts', async () => {
    const unranked = CATALOGUE.map((r) => ({ ...r, fitmentPriority: null }));
    const { ids, res } = await queue(unranked);
    expect(ids).toEqual([]);
    expect(res.meta.total).toBe(0);
  });

  it('limit takes the ranking from the top (#1 … #N); total still counts all ranked parts', async () => {
    const { ids, res } = await queue(CATALOGUE, { limit: 2 });
    expect(ids).toEqual(['p_b', 'p_a']);
    expect(res.meta.total).toBe(4);
  });

  it('search narrows within the ranked parts and keeps their order', async () => {
    const { ids } = await queue(CATALOGUE, { search: 'колодки' });
    expect(ids).toEqual(['p_a', 'p_e']);
  });

  it('a newly bound part keeps its place (fitment work does not reshuffle the list)', async () => {
    const afterBinding = CATALOGUE.map((r) =>
      r.id === 'p_a' ? { ...r, fitmentBindings: bound('gentra') } : r,
    );
    expect((await queue(afterBinding)).ids).toEqual(TOP300_ORDER);
  });
});

describe('FitmentQueueService — unmapped and all are separate from top300', () => {
  it('unmapped = every part bound to nothing, ranked or not (ranked first)', async () => {
    const { ids } = await queue(CATALOGUE, { filter: 'unmapped' });
    expect(ids).toEqual(['p_b', 'p_a', 'p_c', 'p_d']);
  });

  it('all = the whole catalogue: ranked parts by priority, then the rest by id', async () => {
    const { ids } = await queue(CATALOGUE, { filter: 'all' });
    expect(ids).toEqual(['p_b', 'p_a', 'p_c', 'p_e', 'p_d', 'p_f']);
  });

  it('with nothing ranked, unmapped and all still work', async () => {
    const unranked = CATALOGUE.map((r) => ({ ...r, fitmentPriority: null }));
    expect((await queue(unranked, { filter: 'unmapped' })).ids).toEqual([
      'p_a',
      'p_b',
      'p_c',
      'p_d',
    ]);
    expect((await queue(unranked, { filter: 'all' })).ids).toHaveLength(6);
  });
});

describe('orderRows sanity — the evaluator catches an order the database would not fix', () => {
  it('throws when priority alone is the order and two parts share it', () => {
    expect(() =>
      orderRows(
        CATALOGUE.filter((r) => r.fitmentPriority === 2),
        [{ fitmentPriority: 'asc' }],
      ),
    ).toThrow(/tied/);
  });
});
