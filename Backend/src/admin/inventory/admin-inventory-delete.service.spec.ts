// Deleting a part from the inventory console removes it for good: the supply-side
// Stock (and an orphaned Product) go with it so re-projection cannot bring it back,
// a part reserved for an open order is skipped, and every deletion is audited.

import { AdminAuditAction, Prisma, SaleScopeType } from '@prisma/client';
import {
  AdminInventoryDeleteService,
  stockIdOf,
} from './admin-inventory-delete.service';

const part = (id: string, reservedQty = 0) => ({
  id,
  title: `Part ${id}`,
  sellerId: 'dv',
  categoryId: 'cat',
  priceUzs: new Prisma.Decimal(1000),
  purchasePriceUzs: null,
  stockQty: 3,
  reservedQty,
  oemNumbers: ['96'],
  gmNumbers: [],
  images: ['https://img/1.jpg'],
});

function setup(
  parts: ReturnType<typeof part>[],
  stocks: { id: number; productId: number }[] = [],
  stillListed: { productId: number }[] = [],
) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async () => {
      calls.push('lock');
      return [];
    }),
    catalogPart: {
      findMany: jest.fn(async () => parts),
      deleteMany: jest.fn(
        async ({ where }: { where: { id: { in: string[] } } }) => {
          calls.push('part.delete');
          return { count: where.id.in.length };
        },
      ),
    },
    stock: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(
          stocks.map((s) => ({
            ...s,
            sourceSystem: 'DRIVERS_VILLAGE',
            sourceCode: `c${s.id}`,
          })),
        )
        .mockResolvedValueOnce(stillListed),
      deleteMany: jest.fn(async () => {
        calls.push('stock.delete');
        return { count: stocks.length };
      }),
    },
    product: { deleteMany: jest.fn(async () => ({ count: 1 })) },
    cartItem: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    saleTarget: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  };
  const prisma = { $transaction: (run: (t: unknown) => unknown) => run(tx) };
  const audit = { recordMany: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminInventoryDeleteService(
    prisma as never,
    audit as never,
  );
  return { service, tx, audit, calls };
}

describe('stockIdOf', () => {
  it('reads the Stock id of a projected part and nothing else', () => {
    expect(stockIdOf('part_stock_42')).toBe(42);
    expect(stockIdOf('part_abc')).toBeNull();
    expect(stockIdOf('part_stock_')).toBeNull();
    expect(stockIdOf('part_stock_99999999999')).toBeNull();
    expect(stockIdOf('xpart_stock_1')).toBeNull();
  });
});

describe('AdminInventoryDeleteService.batchDelete', () => {
  it('locks before it deletes, and removes Stock, orphaned Product, cart lines, sale targets and the part', async () => {
    const { service, tx, calls } = setup(
      [part('part_seed'), part('part_stock_7')],
      [{ id: 7, productId: 70 }],
      [],
    );
    const res = await service.batchDelete({
      ids: ['part_stock_7', 'part_seed'],
    });

    expect(calls[0]).toBe('lock');
    expect(calls.indexOf('stock.delete')).toBeLessThan(
      calls.indexOf('part.delete'),
    );
    expect(tx.stock.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [7] } },
    });
    expect(tx.product.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [70] } },
    });
    expect(tx.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { partId: { in: ['part_seed', 'part_stock_7'] } },
    });
    expect(tx.saleTarget.deleteMany).toHaveBeenCalledWith({
      where: {
        targetType: SaleScopeType.PRODUCTS,
        targetId: { in: ['part_seed', 'part_stock_7'] },
      },
    });
    expect(res.data).toEqual({ deleted: 2, reserved: [], missing: [] });
  });

  it('keeps a Product another seller still lists', async () => {
    const { service, tx } = setup(
      [part('part_stock_7')],
      [{ id: 7, productId: 70 }],
      [{ productId: 70 }],
    );
    await service.batchDelete({ ids: ['part_stock_7'] });
    expect(tx.stock.deleteMany).toHaveBeenCalled();
    expect(tx.product.deleteMany).not.toHaveBeenCalled();
  });

  it('skips a part reserved for an open order and reports ids that do not exist', async () => {
    const { service, tx } = setup([part('part_a', 2), part('part_b')]);
    const res = await service.batchDelete({
      ids: ['part_a', 'part_b', 'part_gone'],
    });
    expect(tx.catalogPart.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['part_b'] } },
    });
    expect(res.data).toEqual({
      deleted: 1,
      reserved: ['part_a'],
      missing: ['part_gone'],
    });
  });

  it('touches nothing when every part is reserved', async () => {
    const { service, tx, audit } = setup([part('part_stock_1', 1)]);
    const res = await service.batchDelete({ ids: ['part_stock_1'] });
    expect(tx.stock.deleteMany).not.toHaveBeenCalled();
    expect(tx.catalogPart.deleteMany).not.toHaveBeenCalled();
    expect(audit.recordMany).not.toHaveBeenCalled();
    expect(res.data.deleted).toBe(0);
  });

  it('audits each deleted part with what it was', async () => {
    const { service, audit } = setup(
      [part('part_stock_7')],
      [{ id: 7, productId: 70 }],
      [],
    );
    await service.batchDelete(
      { ids: ['part_stock_7'] },
      { actor: { id: 'adm', email: 'a@b.c', name: 'A' } },
    );
    const [entries] = audit.recordMany.mock.calls[0] as [
      {
        action: string;
        target: { id: string };
        previousValues: Record<string, unknown>;
      }[],
    ];
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe(AdminAuditAction.CATALOG_PART_DELETED);
    expect(entries[0].target.id).toBe('part_stock_7');
    expect(entries[0].previousValues).toMatchObject({
      title: 'Part part_stock_7',
      retailPrice: 1000,
      stockId: 7,
      productId: 70,
      productDeleted: true,
      sourceCode: 'c7',
      images: ['https://img/1.jpg'],
    });
  });
});
