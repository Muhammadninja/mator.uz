// LOW-ADM-009 (inventory batch) and INFO-13: the admin stock writer locks the
// rows it changes, never writes reserved_qty, and audits each edit against the
// values that edit actually replaced.

import { AdminAuditAction, Prisma } from '@prisma/client';
import { AdminInventoryService } from './admin-inventory.service';

const part = (id: string, stockQty: number, price = 100) => ({
  id,
  title: `Part ${id}`,
  purchasePriceUzs: null,
  priceUzs: new Prisma.Decimal(price),
  cashbackPct: new Prisma.Decimal(0),
  stockQty,
});

function setup(rows: ReturnType<typeof part>[]) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      calls.push(`lock:${strings.join('?').replace(/\s+/g, ' ').trim()}`);
      return [];
    }),
    catalogPart: {
      findMany: jest.fn(async () => {
        calls.push('read');
        return rows;
      }),
      updateMany: jest.fn(async () => {
        calls.push('write');
        return { count: 1 };
      }),
    },
  };
  const prisma = { $transaction: (run: (t: unknown) => unknown) => run(tx) };
  const audit = { recordMany: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminInventoryService(prisma as never, audit as never);
  const entries = () =>
    (audit.recordMany.mock.calls[0] as unknown[])[0] as {
      action: string;
      actor: unknown;
      previousValues: Record<string, unknown>;
      newValues: Record<string, unknown>;
      target: { id: string };
    }[];
  return { service, tx, audit, calls, entries };
}

const ACTOR = { id: 'adm_1', email: 'op@example.com', name: 'Op' };

describe('AdminInventoryService.batchUpdate', () => {
  it('locks the rows, in id order, before reading or writing them', async () => {
    const { service, tx, calls } = setup([part('b', 5), part('a', 1)]);
    await service.batchUpdate(
      {
        items: [
          { id: 'b', stock: 7 },
          { id: 'a', stock: 2 },
        ],
      } as never,
      { actor: ACTOR },
    );

    expect(calls[0]).toMatch(
      /^lock:SELECT id FROM catalog_parts WHERE id = ANY\(\?::text\[\]\) ORDER BY id FOR UPDATE$/,
    );
    expect((tx.$queryRaw.mock.calls[0] as unknown[])[1]).toEqual(['a', 'b']);
    expect(calls.slice(1)).toEqual(['read', 'write', 'write']);
  });

  it('a part named twice in one batch is audited against the previous edit, not the starting value', async () => {
    const { service, entries } = setup([part('a', 5)]);
    await service.batchUpdate(
      {
        items: [
          { id: 'a', stock: 7 },
          { id: 'a', stock: 9 },
        ],
      } as never,
      { actor: ACTOR },
    );

    expect(entries().map((e) => [e.previousValues, e.newValues])).toEqual([
      [{ stock: 5 }, { stock: 7 }],
      [{ stock: 7 }, { stock: 9 }],
    ]);
  });

  it('a repeated edit that changes nothing leaves no second entry', async () => {
    const { service, entries } = setup([part('a', 5)]);
    await service.batchUpdate(
      {
        items: [
          { id: 'a', stock: 7 },
          { id: 'a', stock: 7 },
        ],
      } as never,
      { actor: ACTOR },
    );
    expect(entries()).toHaveLength(1);
  });

  it('records the actor and writes the audit inside the same transaction', async () => {
    const { service, tx, audit, entries } = setup([part('a', 5)]);
    await service.batchUpdate({ items: [{ id: 'a', stock: 0 }] } as never, {
      actor: ACTOR,
      ip: '203.0.113.1',
    });
    expect(entries()[0]).toMatchObject({
      action: AdminAuditAction.INVENTORY_UPDATED,
      actor: ACTOR,
      target: { id: 'a' },
    });
    expect((audit.recordMany.mock.calls[0] as unknown[])[1]).toBe(tx);
  });

  it('writes only the named columns: stock with its availability flag, never reserved_qty', async () => {
    const { service, tx } = setup([part('a', 5)]);
    await service.batchUpdate(
      {
        items: [
          { id: 'a', stock: 0 },
          { id: 'a', retailPrice: 250 },
        ],
      } as never,
      {},
    );
    const writes = tx.catalogPart.updateMany.mock.calls.map(
      (c) => (c as unknown as [{ data: Record<string, unknown> }])[0].data,
    );
    expect(writes[0]).toEqual({ stockQty: 0, inStock: false });
    expect(Object.keys(writes[1])).toEqual(['priceUzs']);
    for (const data of writes) expect(data).not.toHaveProperty('reservedQty');
  });
});
