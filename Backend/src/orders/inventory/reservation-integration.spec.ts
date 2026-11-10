/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- the Prisma harness is untyped by design */
// How the reservation code is wired into checkout and the 1C projection.
import { ConflictException } from '@nestjs/common';
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import { TelegramNotifierService } from '../../telegram/telegram-notifier.service';
import { OrderStatusService } from '../order-status.service';
import { OrdersService } from '../orders.service';
import { DiscountService } from '../../sales/discount.service';
import {
  buildCart,
  buildCartItem,
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeDeliveryQuotes,
  fakeNotifications,
  fakeRealtime,
} from '../../../test/utils/harness';

const USER = 'usr_1';
const PICKUP = { cart_snapshot: { delivery_method: 'pickup' } } as never;

function checkout(stock: {
  stockQty: number;
  reservedQty: number;
  inTx?: () => void;
}) {
  const prisma: any = createPrismaMock();
  const events: string[] = [];
  let inTransaction = false;
  const items = [
    buildCartItem({ id: 'line_1', cartId: 'cart_1', quantity: 2 }),
  ];
  prisma.cart.findUnique.mockImplementation(async () =>
    buildCart({
      id: 'cart_1',
      userId: USER,
      items: items.map((i) => ({ ...i })),
    }),
  );
  prisma.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) => {
    const text = sql.join(' ');
    if (text.includes('FROM carts')) inTransaction = true;
    if (text.includes('NO KEY UPDATE')) events.push('lock');
    if (text.includes('FOR SHARE')) events.push('share');
    return [];
  });
  prisma.$executeRaw.mockResolvedValue(1);
  prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });
  prisma.catalogPart.findMany.mockImplementation(async ({ where }: any) =>
    where.id?.in
      ? where.id.in.map((id: string) => ({
          id,
          inStock: true,
          stockQty:
            inTransaction && stock.inTx
              ? (stock.inTx(), stock.stockQty)
              : stock.stockQty,
          reservedQty: stock.reservedQty,
          priceUzs: 185000,
          seller: { status: 'ACTIVE', name: 'S' },
          categoryId: 'cat_1',
          sellerId: 'seller_1',
          oemNumbers: [],
          gmNumbers: [],
          title: 'Belt',
        }))
      : [],
  );
  prisma.sale.findMany.mockResolvedValue([]);
  prisma.seller.findMany.mockResolvedValue([]);
  prisma.stock.findMany.mockResolvedValue([]);
  prisma.inventoryReservation.createMany.mockImplementation(async () => {
    events.push('reserve');
    return { count: 1 };
  });
  prisma.inventoryReservation.updateMany.mockResolvedValue({ count: 0 });
  prisma.stockShortageAttempt.create.mockImplementation(
    async ({ data }: any) => {
      expect(inTransaction).toBe(false);
      events.push('attempt');
      return data;
    },
  );
  prisma.sourcingTicket.findFirst.mockResolvedValue(null);
  prisma.sourcingTicket.create.mockImplementation(async ({ data }: any) => {
    events.push('ticket');
    return { id: data.id };
  });
  prisma.sourcingRequest.create.mockResolvedValue({ id: 'req' });
  prisma.order.create.mockImplementation(async () =>
    buildOrder({
      id: 'ord_1',
      items: [{ id: 'oi_1', partId: 'part_belt', title: 'Belt', quantity: 2 }],
    }),
  );
  prisma.$transaction.mockImplementation(async (work: any) => {
    try {
      return await work(prisma);
    } catch (err) {
      if (inTransaction) events.push('rollback');
      throw err;
    } finally {
      inTransaction = false;
    }
  });
  const orders = new OrdersService(
    prisma,
    fakeConfig(),
    fakeNotifications(),
    fakeRealtime(),
    new OrderStatusService(prisma),
    new DiscountService(prisma),
    { record: jest.fn() } as never,
    fakeDeliveryQuotes(),
  );
  return { orders, prisma, events };
}

describe('checkout with reservations on', () => {
  beforeEach(() => {
    process.env.INVENTORY_RESERVATIONS_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.INVENTORY_RESERVATIONS_ENABLED;
  });

  it('locks the parts before reading them, and reserves inside the transaction', async () => {
    const { orders, events } = checkout({ stockQty: 5, reservedQty: 0 });
    await orders.createFromCart(USER, PICKUP);
    expect(events.indexOf('lock')).toBeLessThan(events.indexOf('share'));
    expect(events).toContain('reserve');
  });

  it('a buyer short before the transaction gets the 409 and one ticket', async () => {
    const { orders, events } = checkout({ stockQty: 1, reservedQty: 0 });
    const err = await orders
      .createFromCart(USER, PICKUP)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(events).toContain('ticket');
    expect(events).not.toContain('reserve');
  });

  it('losing the race inside the transaction rolls back first, and only then tells anyone', async () => {
    const stock: any = {
      stockQty: 5,
      reservedQty: 0,
      inTx() {
        stock.reservedQty = 5;
      },
    };
    const { orders, events, prisma } = checkout(stock);
    await expect(orders.createFromCart(USER, PICKUP)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(events.indexOf('rollback')).toBeLessThan(events.indexOf('attempt'));
  });

  it('an order that rolls back for any other reason sends nothing', async () => {
    const { orders, events, prisma } = checkout({
      stockQty: 5,
      reservedQty: 0,
    });
    prisma.order.create.mockRejectedValueOnce(new Error('db error'));
    await expect(orders.createFromCart(USER, PICKUP)).rejects.toThrow(
      'db error',
    );
    expect(events).not.toContain('attempt');
    expect(events).not.toContain('ticket');
  });
});

describe('checkout with reservations off', () => {
  it('takes no new lock and writes no reservation', async () => {
    const { orders, events, prisma } = checkout({
      stockQty: 5,
      reservedQty: 4,
    });
    await orders.createFromCart(USER, PICKUP);
    expect(events).not.toContain('lock');
    expect(prisma.inventoryReservation.createMany).not.toHaveBeenCalled();
  });
});

describe('a 1C quantity reaching the catalog', () => {
  function projector(partQty: number) {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      catalogPart: {
        findUnique: jest.fn().mockResolvedValue({ stockQty: partQty }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'r1',
            partId: 'part_stock_7',
            quantity: 3,
            reconciledQty: 0,
            restockedQty: 0,
            status: 'ALLOCATED',
            allocatedAt: new Date('2026-11-01T00:00:00Z'),
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma: any = {
      stock: {
        findUnique: jest.fn().mockResolvedValue({
          priceUzs: 1,
          quantity: 7,
          sourceSystem: 'DRIVERS_VILLAGE_1C',
        }),
      },
      catalogPart: {
        findUnique: jest.fn().mockResolvedValue({ id: 'part_stock_7' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((fn: any) => fn(tx)),
    };
    return { service: new CatalogProjectionService(prisma), prisma, tx };
  }
  const source = { at: new Date('2026-11-02T00:00:00Z'), ref: '1C file a.txt' };

  afterEach(() => {
    delete process.env.INVENTORY_RESERVATIONS_ENABLED;
  });

  it('writes the count and settles the sale in one transaction under the lock', async () => {
    process.env.INVENTORY_RESERVATIONS_ENABLED = 'true';
    const { service, tx, prisma } = projector(10);
    await service.projectStockLevels(
      7,
      { price: false, quantity: true },
      source,
    );
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.catalogPart.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stockQty: 7 }),
      }),
    );
    expect(tx.inventoryReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'RECONCILED' }),
      }),
    );
    expect(prisma.catalogPart.update).not.toHaveBeenCalled();
  });

  it('a retried projection after the count landed finds nothing to settle', async () => {
    process.env.INVENTORY_RESERVATIONS_ENABLED = 'true';
    const { service, tx } = projector(7);
    await service.projectStockLevels(
      7,
      { price: false, quantity: true },
      source,
    );
    expect(tx.inventoryReservation.updateMany).not.toHaveBeenCalled();
  });

  it('a price-only change does not open that transaction', async () => {
    process.env.INVENTORY_RESERVATIONS_ENABLED = 'true';
    const { service, prisma } = projector(10);
    await service.projectStockLevels(
      7,
      { price: true, quantity: false },
      source,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('feature off: the write is exactly what it was', async () => {
    const { service, prisma } = projector(10);
    await service.projectStockLevels(
      7,
      { price: false, quantity: true },
      source,
    );
    expect(prisma.catalogPart.update).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('the existing dealer card', () => {
  const notifier = new TelegramNotifierService({ get: () => '' } as never);

  it('carries the shortage and nothing about the customer', () => {
    const text = notifier.formatTicket({
      id: 't1',
      partName: 'Belt',
      userId: 'buyer-uuid',
      extractedData: {
        part_name: 'Belt',
        stock_shortage: {
          part_id: 'part_stock_1',
          part_numbers: ['GM1', 'OEM1'],
          requested_qty: 5,
          seller: "Driver's Village",
          reported_qty: 2,
          reserved_qty: 1,
          reference: 'sshort_1',
        },
      },
    } as never);
    expect(text).toContain('GM1, OEM1');
    expect(text).toContain('<b>Quantity needed:</b> 5');
    expect(text).toContain("Driver's Village");
    expect(text).toContain('<b>Supplier-reported:</b> 2');
    expect(text).toContain('<b>Reserved:</b> 1');
    expect(text).not.toContain('buyer-uuid');
  });
});
