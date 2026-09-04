import { PrismaService } from '../prisma/prisma.service';
import { SyncMode } from './dto/sync-inventory.dto';
import { IntegrationsService } from './integrations.service';
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
  const $transaction = jest.fn<Promise<{ count: number }[]>, [unknown[]]>();

  const prisma = {
    catalogPart: { findMany, updateMany },
    catalogSeller: { update },
    $transaction,
  } as unknown as PrismaService;

  let service: IntegrationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IntegrationsService(prisma);
    // updateMany returns a promise-like descriptor; $transaction resolves them
    // to one {count:1} per queued update, as Prisma does for a matched row.
    updateMany.mockImplementation(() => ({ count: 1 }));
    $transaction.mockImplementation((ops: unknown[]) =>
      Promise.resolve(ops as { count: number }[]),
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
    updateMany.mockImplementationOnce(() => ({ count: 1 }));
    updateMany.mockResolvedValueOnce({ count: 7 });

    const result = await service.syncInventory(dealer, {
      mode: SyncMode.FULL,
      items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
    });

    expect(result.zeroedCount).toBe(7);
    const sweep = updateMany.mock.calls[1][0];
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
    updateMany.mockImplementationOnce(() => ({ count: 1 }));
    updateMany.mockResolvedValueOnce({ count: 42 });

    const result = await service.syncInventory(dealer, {
      mode: SyncMode.FULL,
      items: [{ article: 'A1', title: 'X', quantity: 1, price: 1 }],
    });

    expect(result.zeroedCount).toBe(42);
    expect(updateMany.mock.calls[1][0].where).toMatchObject({
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
