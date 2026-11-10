import { PrismaService } from '../prisma/prisma.service';
import { SyncMode } from './dto/sync-inventory.dto';
import { MAX_STOCK_QTY, IntegrationsService } from './integrations.service';
import type { IntegrationDealer } from './interfaces/integration-dealer.interface';

const dealer: IntegrationDealer = {
  id: 'dealer_1',
  name: 'AutoPro',
  status: 'ACTIVE',
  apiKeyLast4: 'ab12',
};

/**
 * `expect.objectContaining` and `expect.any` are typed `any` by @types/jest,
 * which trips no-unsafe-assignment once the mocks themselves are typed. These
 * thin wrappers put the matcher back behind the parameter type it is checked
 * against, so the assertions below stay both readable and type-safe.
 */
function containing<T>(shape: Partial<Record<keyof T, unknown>>): T {
  const matcher: unknown = expect.objectContaining(shape);
  return matcher as T;
}
function anyDate(): Date {
  const matcher: unknown = expect.any(Date);
  return matcher as Date;
}

/** Shape of the one findMany select this service issues. */
interface PartRow {
  id: string;
  oemNumbers: string[];
  gmNumbers: string[];
}

/** The subset of a Prisma updateMany argument the assertions read back. */
interface UpdateManyArgs {
  where: { id?: string; sellerId?: string; notIn?: string[] } & Record<
    string,
    unknown
  >;
  data: {
    stockQty?: number;
    inStock?: boolean;
    purchasePriceUzs?: { toString(): string };
  } & Record<string, unknown>;
}

describe('IntegrationsService.syncInventory', () => {
  const findMany = jest.fn<Promise<PartRow[]>, [unknown]>();
  const updateMany = jest.fn<
    { count: number } | Promise<{ count: number }>,
    [UpdateManyArgs]
  >();
  const update = jest.fn<Promise<unknown>, [unknown]>();
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const $executeRaw = jest.fn(() => 1);

  const prisma = {
    catalogPart: { findMany, updateMany },
    catalogSeller: { update },
    $transaction,
    $executeRaw,
  } as unknown as PrismaService;

  let service: IntegrationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IntegrationsService(prisma);
    // updateMany returns a promise-like descriptor; $transaction resolves them
    // to one {count:1} per queued update, as Prisma does for a matched row.
    updateMany.mockImplementation(() => ({ count: 1 }));
    $transaction.mockImplementation((ops: unknown) =>
      typeof ops === 'function'
        ? (ops as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.resolve(ops),
    );
    update.mockResolvedValue({});
  });

  it('matches a NORMALIZED article against the catalog and writes stock + cost', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['96943770'], gmNumbers: [] },
    ]);

    const result = await service.syncInventory(dealer, {
      // Sent with separators and lowercase; the catalog stores "96943770".
      items: [
        { article: '96.943.770', title: 'Фильтр', quantity: 42, price: 185000 },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.processedCount).toBe(1);
    expect(result.receivedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(updateMany).toHaveBeenCalledWith(
      containing<UpdateManyArgs>({
        where: { id: 'part_1', sellerId: 'dealer_1' },
        data: containing<UpdateManyArgs['data']>({
          stockQty: 42,
          inStock: true,
        }),
      }),
    );
  });

  it('scopes both the read and the write to the calling dealer', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: [] },
    ]);

    await service.syncInventory(dealer, {
      items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
    });

    expect(findMany).toHaveBeenCalledWith(
      containing<{ where: unknown }>({
        where: containing<Record<string, unknown>>({ sellerId: 'dealer_1' }),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      containing<UpdateManyArgs>({
        where: containing<UpdateManyArgs['where']>({ sellerId: 'dealer_1' }),
      }),
    );
  });

  it('sets inStock=false when the quantity is zero', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: [] },
    ]);

    await service.syncInventory(dealer, {
      items: [{ article: 'A1', title: 'X', quantity: 0, price: 1000 }],
    });

    expect(updateMany).toHaveBeenCalledWith(
      containing<UpdateManyArgs>({
        data: containing<UpdateManyArgs['data']>({
          stockQty: 0,
          inStock: false,
        }),
      }),
    );
  });

  it('never writes the retail price', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: [] },
    ]);

    await service.syncInventory(dealer, {
      items: [{ article: 'A1', title: 'X', quantity: 3, price: 5000 }],
    });

    const { data } = updateMany.mock.calls[0][0];
    expect(data).not.toHaveProperty('priceUzs');
    expect(data.purchasePriceUzs.toString()).toBe('5000');
  });

  it('PARTIAL: an overflowing total is refused before the first chunk commits (LOW-ING-011)', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: [] },
      { id: 'part_2', oemNumbers: ['B2'], gmNumbers: [] },
    ]);
    const rows = [
      // A valid position that a chunked write would have committed first.
      { article: 'B2', title: 'Y', quantity: 5, price: 1000 },
      ...Array.from({ length: 2_148 }, () => ({
        article: 'A1',
        title: 'X',
        quantity: 1_000_000,
        price: 1000,
      })),
    ];
    await expect(service.syncInventory(dealer, { items: rows })).rejects.toMatchObject({
      response: { code: 'SYNC_QUANTITY_OUT_OF_RANGE' },
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('PARTIAL: two articles naming one part cannot sum past the column either', async () => {
    findMany.mockResolvedValue([
      {
        id: 'part_1',
        oemNumbers: Array.from({ length: 3000 }, (_, i) => `X${i}`),
        gmNumbers: [],
      },
    ]);
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      article: `X${i}`,
      title: 'X',
      quantity: 1_000_000,
      price: 1000,
    }));
    await expect(service.syncInventory(dealer, { items: rows })).rejects.toMatchObject({
      response: { code: 'SYNC_QUANTITY_OUT_OF_RANGE' },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('reports an unknown article as skipped instead of creating a part', async () => {
    findMany.mockResolvedValue([]);

    const result = await service.syncInventory(dealer, {
      items: [
        { article: 'XYZ-999', title: 'Неизвестное', quantity: 5, price: 1000 },
      ],
    });

    expect(result.processedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped).toEqual([
      { article: 'XYZ-999', reason: 'unknown_article' },
    ]);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('SUMS quantities when 1C repeats an article across warehouses', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: [] },
    ]);

    const result = await service.syncInventory(dealer, {
      items: [
        {
          article: 'A1',
          title: 'X',
          quantity: 10,
          price: 1000,
          warehouse: 'SKL-01',
        },
        {
          article: 'A-1',
          title: 'X',
          quantity: 5,
          price: 1000,
          warehouse: 'SKL-02',
        },
      ],
    });

    expect(updateMany).toHaveBeenCalledWith(
      containing<UpdateManyArgs>({
        data: containing<UpdateManyArgs['data']>({ stockQty: 15 }),
      }),
    );
    expect(result.processedCount).toBe(1);
    // A merged repeat is NOT a skip: its stock was applied, not dropped.
    expect(result.skippedCount).toBe(0);
    expect(result.mergedCount).toBe(1);
  });

  it('SUMS two DIFFERENT articles that name the same part', async () => {
    // A part carrying both its OEM and GM number, quoted as two 1C lines. Both
    // are real stock for that position; keeping only the first silently loses
    // the rest while still reporting success.
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: ['B2'] },
    ]);

    const result = await service.syncInventory(dealer, {
      items: [
        { article: 'A1', title: 'X', quantity: 10, price: 100 },
        { article: 'B2', title: 'X', quantity: 99, price: 100 },
      ],
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      containing<UpdateManyArgs>({
        data: containing<UpdateManyArgs['data']>({ stockQty: 109 }),
      }),
    );
    expect(result.mergedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
  });

  it('reports an unsearchable (e.g. Cyrillic) article as unusable, not duplicate', async () => {
    // normalizeOem keeps only A-Z0-9, so a Cyrillic nomenclature code collapses
    // to '' and never enters the search at all — a different failure from a miss.
    findMany.mockResolvedValue([]);

    const result = await service.syncInventory(dealer, {
      items: [{ article: 'ФИЛЬТР', title: 'X', quantity: 1, price: 1 }],
    });

    expect(result.skippedCount).toBe(1);
    expect(result.skipped).toEqual([
      { article: 'ФИЛЬТР', reason: 'unusable_article' },
    ]);
  });

  it('balances: received === processed + skipped + merged', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: ['B2'] },
      { id: 'part_2', oemNumbers: ['C3'], gmNumbers: [] },
    ]);

    const result = await service.syncInventory(dealer, {
      items: [
        { article: 'A1', title: 'X', quantity: 1, price: 1 },
        { article: 'B2', title: 'X', quantity: 2, price: 1 },
        { article: 'A-1', title: 'X', quantity: 3, price: 1 },
        { article: 'C3', title: 'X', quantity: 4, price: 1 },
        { article: 'NOPE', title: 'X', quantity: 5, price: 1 },
        { article: '###', title: 'X', quantity: 6, price: 1 },
      ],
    });

    expect(result.receivedCount).toBe(6);
    expect(
      result.processedCount + result.skippedCount + result.mergedCount,
    ).toBe(result.receivedCount);
  });

  it('matches a GM number as well as an OEM number', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: [], gmNumbers: ['GM123'] },
    ]);

    const result = await service.syncInventory(dealer, {
      items: [{ article: 'gm-123', title: 'X', quantity: 2, price: 100 }],
    });

    expect(result.processedCount).toBe(1);
  });

  it('writes a part once even when two articles resolve to the same row', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: ['B2'] },
    ]);

    await service.syncInventory(dealer, {
      items: [
        { article: 'A1', title: 'X', quantity: 3, price: 100 },
        { article: 'B2', title: 'X', quantity: 4, price: 100 },
      ],
    });

    // One write, carrying the SUM — not two writes racing to overwrite.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      containing<UpdateManyArgs>({
        data: containing<UpdateManyArgs['data']>({ stockQty: 7 }),
      }),
    );
  });

  it('does NOT zero absent positions in partial mode', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: [] },
    ]);

    const result = await service.syncInventory(dealer, {
      mode: SyncMode.PARTIAL,
      items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
    });

    expect(result.zeroedCount).toBe(0);
    // The only updateMany calls are the queued per-part writes, never a sweep.
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('defaults to partial mode when mode is absent', async () => {
    findMany.mockResolvedValue([]);

    const result = await service.syncInventory(dealer, {
      items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
    });

    expect(result.zeroedCount).toBe(0);
  });

  it('zeroes untouched positions in full mode, without deleting them', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: [] },
    ]);
    // The sweep is the only direct (non-transaction) updateMany.
    updateMany.mockResolvedValueOnce({ count: 7 });

    const result = await service.syncInventory(dealer, {
      mode: SyncMode.FULL,
      expectedTotal: 1,
      items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
    });

    expect(result.zeroedCount).toBe(7);
    const sweep = updateMany.mock.calls[0][0];
    expect(sweep.where).toMatchObject({
      sellerId: 'dealer_1',
      id: { notIn: ['part_1'] },
    });
    expect(sweep.data).toEqual({ stockQty: 0, inStock: false });
  });

  it('REFUSES to zero the whole catalog when a full sync matches nothing', async () => {
    // The dangerous case: a full export whose article format no longer matches
    // (or the wrong dealer's file). `notIn: []` excludes nothing, so an
    // unguarded sweep would clear every position the dealer has — removing them
    // from the storefront while answering 200 OK.
    findMany.mockResolvedValue([]);

    const result = await service.syncInventory(dealer, {
      mode: SyncMode.FULL,
      expectedTotal: 1,
      items: [{ article: 'TYPO-1', title: 'X', quantity: 5, price: 1 }],
    });

    expect(result.zeroedCount).toBe(0);
    // No sweep was issued at all.
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('still zeroes the remainder when a full sync matched something', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: [] },
    ]);
    updateMany.mockResolvedValueOnce({ count: 42 });

    const result = await service.syncInventory(dealer, {
      mode: SyncMode.FULL,
      expectedTotal: 1,
      items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
    });

    expect(result.zeroedCount).toBe(42);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      id: { notIn: ['part_1'] },
    });
  });

  it('stamps apiKeyLastUsedAt on success', async () => {
    findMany.mockResolvedValue([]);

    await service.syncInventory(dealer, {
      items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
    });

    expect(update).toHaveBeenCalledWith(
      containing<{ where: unknown; data: unknown }>({
        where: { id: 'dealer_1' },
        data: { apiKeyLastUsedAt: anyDate() },
      }),
    );
  });

  it('still succeeds when the liveness stamp fails', async () => {
    findMany.mockResolvedValue([]);
    update.mockRejectedValue(new Error('write conflict'));

    await expect(
      service.syncInventory(dealer, {
        items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
      }),
    ).resolves.toMatchObject({ success: true });
  });

  it('propagates a database failure instead of reporting a false success', async () => {
    findMany.mockResolvedValue([
      { id: 'part_1', oemNumbers: ['A1'], gmNumbers: [] },
    ]);
    $transaction.mockRejectedValue(new Error('deadlock detected'));

    await expect(
      service.syncInventory(dealer, {
        items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
      }),
    ).rejects.toThrow('deadlock detected');
  });

  it('returns a timestamp and a duration', async () => {
    findMany.mockResolvedValue([]);

    const result = await service.syncInventory(dealer, {
      items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
    });

    expect(result.message).toBe('Inventory synchronized successfully');
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('truncates the skip sample but keeps the count complete', async () => {
    findMany.mockResolvedValue([]);
    const items = Array.from({ length: 120 }, (_, i) => ({
      article: `UNKNOWN-${i}`,
      title: 'X',
      quantity: 1,
      price: 1,
    }));

    const result = await service.syncInventory(dealer, { items });

    expect(result.skippedCount).toBe(120);
    expect(result.skipped).toHaveLength(50);
  });
});

describe('FULL sync is one complete, atomic upload (ING-003)', () => {
  const part = (id: string, oem: string) => ({
    id,
    oemNumbers: [oem],
    gmNumbers: [],
  });
  const item = (article: string, quantity = 5) => ({
    article,
    title: 'T',
    quantity,
    price: 1000,
  });

  /** One in-memory dealer inventory; a FULL sync runs on a copy until it commits. */
  function world() {
    let stock: Record<string, number> = { a: 1, b: 2, c: 3 };
    let queue: Promise<unknown> = Promise.resolve();
    const articles: Record<string, string> = {
      AAA111: 'a',
      BBB222: 'b',
      CCC333: 'c',
    };
    const tx = (draft: Record<string, number>) => ({
      $executeRaw: jest.fn((sql: TemplateStringsArray, ...args: unknown[]) => {
        if (sql.join('').includes('UPDATE catalog_parts')) {
          const ids = args[0] as string[];
          const quantities = args[1] as number[];
          ids.forEach((id, i) => (draft[id] = quantities[i]));
          return Promise.resolve(ids.length);
        }
        return Promise.resolve(1);
      }),
      catalogPart: {
        findMany: jest.fn(() =>
          Promise.resolve(
            Object.entries(articles).map(([oem, id]) => part(id, oem)),
          ),
        ),
        updateMany: jest.fn(({ where }: any) => {
          let count = 0;
          for (const id of Object.keys(draft)) {
            if (!where.id.notIn.includes(id) && draft[id] > 0) {
              draft[id] = 0;
              count += 1;
            }
          }
          return Promise.resolve({ count });
        }),
      },
    });
    const prisma = {
      catalogSeller: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((work: (t: unknown) => Promise<unknown>) => {
        const run = queue.then(async () => {
          const draft = { ...stock };
          const result = await work(tx(draft));
          stock = draft;
          return result;
        });
        queue = run.catch(() => undefined);
        return run;
      }),
    };
    return {
      service: new IntegrationsService(prisma as never),
      prisma,
      stock: () => stock,
    };
  }

  // LOW-ING-011: a sum that does not fit the column is refused before any write.
  describe('quantity overflow', () => {
    const MAX_ROW = 1_000_000;
    const repeats = (article: string, n: number) =>
      Array.from({ length: n }, () => item(article, MAX_ROW));

    it('FULL: 2,148 rows of one article at the per-row maximum change nothing and zero nothing', async () => {
      const { service, stock, prisma } = world();
      await expect(
        service.syncInventory(dealer, {
          mode: SyncMode.FULL,
          items: repeats('AAA111', 2_148),
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'SYNC_QUANTITY_OUT_OF_RANGE' },
      });
      expect(stock()).toEqual({ a: 1, b: 2, c: 3 });
      // Refused before a transaction was even opened.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('the largest total that fits still applies', async () => {
      const { service, stock } = world();
      await service.syncInventory(dealer, {
        mode: SyncMode.FULL,
        items: [...repeats('AAA111', 2_147), item('AAA111', 483_647)],
      });
      expect(stock().a).toBe(MAX_STOCK_QTY);
    });
  });

  it('keeps accepting a FULL upload that does not state its size', async () => {
    const { service, stock } = world();
    await service.syncInventory(dealer, {
      mode: SyncMode.FULL,
      items: [item('AAA111', 7), item('BBB222', 9), item('CCC333', 4)],
    });
    expect(stock()).toEqual({ a: 7, b: 9, c: 4 });
  });

  describe('Driver’s Village', () => {
    const dv = { ...dealer, id: 'drivers-village' };

    it.each([
      ['full', SyncMode.FULL],
      ['partial', SyncMode.PARTIAL],
      ['the default', undefined],
    ])('refuses %s mode before reading or writing anything', async (_n, mode) => {
      const { service, prisma, stock } = world();
      await expect(
        service.syncInventory(dv, { mode, items: [item('AAA111', 7)] }),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'INVENTORY_SYNC_NOT_AVAILABLE' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.catalogSeller.update).not.toHaveBeenCalled();
      expect(stock()).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('applies to no other dealer', async () => {
      const { service } = world();
      await expect(
        service.syncInventory(dealer, {
          mode: SyncMode.FULL,
          items: [item('AAA111', 7)],
        }),
      ).resolves.toMatchObject({ success: true });
    });
  });

  it('a page that states the size of the longer export cannot zero the earlier ones', async () => {
    const { service, prisma, stock } = world();
    await expect(
      service.syncInventory(dealer, {
        mode: SyncMode.FULL,
        expectedTotal: 3,
        items: [item('AAA111')],
      }),
    ).rejects.toMatchObject({ response: { code: 'FULL_SYNC_INCOMPLETE' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(stock()).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('a complete upload produces the final inventory and zeroes the rest', async () => {
    const { service, stock } = world();
    const result = await service.syncInventory(dealer, {
      mode: SyncMode.FULL,
      expectedTotal: 2,
      items: [item('AAA111', 7), item('BBB222', 9)],
    });
    expect(stock()).toEqual({ a: 7, b: 9, c: 0 });
    expect(result.processedCount).toBe(2);
    expect(result.zeroedCount).toBe(1);
  });

  it('commits nothing when the zeroing fails', async () => {
    const { service, prisma, stock } = world();
    const original = prisma.$transaction.getMockImplementation()!;
    prisma.$transaction.mockImplementationOnce((work) =>
      original(async (t: any) => {
        t.catalogPart.updateMany.mockRejectedValue(new Error('deadlock'));
        return work(t);
      }),
    );
    await expect(
      service.syncInventory(dealer, {
        mode: SyncMode.FULL,
        expectedTotal: 1,
        items: [item('AAA111', 7)],
      }),
    ).rejects.toThrow('deadlock');
    expect(stock()).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('two FULL syncs leave one complete upload, never a mix', async () => {
    const { service, stock } = world();
    await Promise.all([
      service.syncInventory(dealer, {
        mode: SyncMode.FULL,
        expectedTotal: 1,
        items: [item('AAA111', 7)],
      }),
      service.syncInventory(dealer, {
        mode: SyncMode.FULL,
        expectedTotal: 1,
        items: [item('BBB222', 9)],
      }),
    ]);
    expect(stock()).toEqual({ a: 0, b: 9, c: 0 });
  });
});
