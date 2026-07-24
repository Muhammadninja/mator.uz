// Unit tests for the admin orders console (GET /v1/admin/orders[/:id]). Prisma
// is mocked — no DB. These guard: pagination meta + offset math, the whitelisted
// sort mapping, comma-separated status parsing (incl. `all` and the 400 on an
// unknown status), phone-normalized search, the row/detail presenter shapes,
// the synthesized-first chronological status history, and null shipping on
// pickup. A separate block validates the query DTO rejects bad sort input (400).

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderActorType, OrderStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminOrdersService } from './admin-orders.service';
import { ListAdminOrdersQueryDto } from './dto/list-admin-orders.query.dto';

function makePrismaMock() {
  const order = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
  };
  const prisma: Record<string, unknown> = { order };
  // Array form runs the (already-invoked) query promises; callback form gets the mock.
  prisma.$transaction = (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(prisma);
  return prisma as { order: typeof order; $transaction: (arg: unknown) => unknown };
}

function listRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ord_1',
    status: OrderStatus.PENDING_PAYMENT,
    totalUzs: 150000,
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    updatedAt: new Date('2026-07-20T11:00:00.000Z'),
    user: {
      id: 'usr_1',
      displayName: 'Ali Valiyev',
      firstName: 'Ali',
      lastName: 'Valiyev',
      phoneE164: '+998903700340',
    },
    payments: [{ provider: 'PAYME', status: 'PAID' }],
    _count: { items: 3 },
    ...over,
  };
}

function detailRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ord_1',
    status: OrderStatus.PROCESSING,
    totalUzs: 450000,
    deliveryUzs: 20000,
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    updatedAt: new Date('2026-07-20T12:00:00.000Z'),
    user: {
      id: 'usr_1',
      displayName: 'Ali Valiyev',
      firstName: 'Ali',
      lastName: 'Valiyev',
      phoneE164: '+998903700340',
      email: 'ali@example.com',
    },
    deliveryAddress: {
      regionCode: 'TAS',
      district: 'Yunusabad',
      street: 'Amir Temur 12',
      fullText: 'Amir Temur 12, Yunusabad, Tashkent',
      lat: 41.31,
      lng: 69.27,
    },
    items: [
      { id: 'oi_1', partId: 'part_1', title: 'Brake pad', quantity: 2, priceUzs: 120000, lineTotalUzs: 240000 },
    ],
    payments: [{ provider: 'CLICK', status: 'PAID' }],
    statusHistory: [
      {
        id: 'osh_0',
        status: OrderStatus.PENDING_PAYMENT,
        note: 'Order created',
        actorType: OrderActorType.SYSTEM,
        actorId: null,
        actorName: null,
        createdAt: new Date('2026-07-20T10:00:00.000Z'),
      },
      {
        id: 'osh_1',
        status: OrderStatus.PAID,
        note: 'Payment received',
        actorType: OrderActorType.SYSTEM,
        actorId: null,
        actorName: null,
        createdAt: new Date('2026-07-20T10:30:00.000Z'),
      },
      {
        id: 'osh_2',
        status: OrderStatus.PROCESSING,
        note: 'Packing',
        actorType: OrderActorType.ADMIN,
        actorId: 'usr_admin',
        actorName: 'Operator One',
        createdAt: new Date('2026-07-20T11:15:00.000Z'),
      },
    ],
    ...over,
  };
}

describe('AdminOrdersService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: AdminOrdersService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new AdminOrdersService(prisma as never);
  });

  describe('list', () => {
    it('returns correct pagination meta and computes offset from page/limit', async () => {
      prisma.order.findMany.mockResolvedValue([listRow()]);
      prisma.order.count.mockResolvedValue(142);

      const res = await service.list({ page: 2, limit: 20 });

      expect(res.meta).toEqual({ page: 2, limit: 20, totalItems: 142, totalPages: 8 });
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
      expect(res.success).toBe(true);
    });

    it('defaults to page 1, limit 20, ordered by createdAt desc', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      const res = await service.list({});

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20, orderBy: { createdAt: 'desc' } }),
      );
      expect(res.meta).toEqual({ page: 1, limit: 20, totalItems: 0, totalPages: 0 });
    });

    it('clamps a limit above 100 down to 100', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      const res = await service.list({ limit: 500 });

      expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
      expect(res.meta.limit).toBe(100);
    });

    it('maps the totalAmount sort onto the real totalUzs column', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.list({ sortBy: 'totalAmount', order: 'asc' });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { totalUzs: 'asc' } }),
      );
    });

    it('applies no status filter for status=all', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.list({ status: 'all' });

      expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    });

    it('parses a comma-separated status filter into where.status.in', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.list({ status: 'pending_payment, paid' });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.PAID] } },
        }),
      );
    });

    it('rejects an unknown status token with 400', async () => {
      await expect(service.list({ status: 'pending_payment,confirmed' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });

    it('normalizes a "+"-prefixed phone search and also searches id/name', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.list({ search: '+998903700340' });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { id: { contains: '+998903700340', mode: 'insensitive' } },
              { user: { displayName: { contains: '+998903700340', mode: 'insensitive' } } },
              { user: { firstName: { contains: '+998903700340', mode: 'insensitive' } } },
              { user: { lastName: { contains: '+998903700340', mode: 'insensitive' } } },
              { user: { phoneE164: { contains: '998903700340' } } },
              { contactPhoneE164: { contains: '998903700340' } },
            ],
          },
        }),
      );
    });

    it('omits phone clauses for a short/non-numeric search term', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.list({ search: 'Ali' });

      // Exactly the id + 3 name clauses, no phone clause.
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { id: { contains: 'Ali', mode: 'insensitive' } },
              { user: { displayName: { contains: 'Ali', mode: 'insensitive' } } },
              { user: { firstName: { contains: 'Ali', mode: 'insensitive' } } },
              { user: { lastName: { contains: 'Ali', mode: 'insensitive' } } },
            ],
          },
        }),
      );
    });

    it('presents the row with latest payment, customer name and itemsCount', async () => {
      prisma.order.findMany.mockResolvedValue([listRow()]);
      prisma.order.count.mockResolvedValue(1);

      const res = await service.list({});

      expect(res.data[0]).toEqual({
        id: 'ord_1',
        status: 'pending_payment',
        totalAmount: 150000,
        paymentMethod: 'payme',
        paymentStatus: 'paid',
        createdAt: '2026-07-20T10:00:00.000Z',
        updatedAt: '2026-07-20T11:00:00.000Z',
        customer: { id: 'usr_1', name: 'Ali Valiyev', phone: '+998903700340' },
        itemsCount: 3,
      });
    });

    it('presents null payment method/status when the order has no payments', async () => {
      prisma.order.findMany.mockResolvedValue([listRow({ payments: [] })]);
      prisma.order.count.mockResolvedValue(1);

      const res = await service.list({});

      expect(res.data[0].paymentMethod).toBeNull();
      expect(res.data[0].paymentStatus).toBeNull();
    });
  });

  describe('getOne', () => {
    it('404s on an unknown order', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.getOne('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps the full detail with items and chronological status history', async () => {
      prisma.order.findUnique.mockResolvedValue(detailRow());

      const { data } = await service.getOne('ord_1');

      expect(data).toEqual(
        expect.objectContaining({
          id: 'ord_1',
          status: 'processing',
          totalAmount: 450000,
          deliveryFee: 20000,
          paymentMethod: 'click',
          paymentStatus: 'paid',
          customer: {
            id: 'usr_1',
            name: 'Ali Valiyev',
            phone: '+998903700340',
            email: 'ali@example.com',
          },
          shippingAddress: {
            city: 'TAS',
            district: 'Yunusabad',
            addressLine: 'Amir Temur 12, Yunusabad, Tashkent',
            landmark: null,
            location: { lat: 41.31, lng: 69.27 },
          },
        }),
      );
      expect(data.items[0]).toEqual({
        id: 'oi_1',
        productId: 'part_1',
        title: 'Brake pad',
        sku: null,
        quantity: 2,
        price: 120000,
        totalPrice: 240000,
        imageUrl: null,
      });
    });

    it('returns the stored status history (creation row included) in order, with structured actors', async () => {
      prisma.order.findUnique.mockResolvedValue(detailRow());

      const { data } = await service.getOne('ord_1');

      // The stored rows ARE the source of truth: created (10:00) -> paid (10:30) -> processing (11:15).
      expect(data.statusHistory.map((h: { status: string }) => h.status)).toEqual([
        'pending_payment',
        'paid',
        'processing',
      ]);
      expect(data.statusHistory[0].actor).toEqual({ type: 'SYSTEM', id: null, name: 'System' });
      expect(data.statusHistory[2].actor).toEqual({
        type: 'ADMIN',
        id: 'usr_admin',
        name: 'Operator One',
      });
    });

    it('synthesizes a single SYSTEM creation entry only for a legacy order with no history rows', async () => {
      prisma.order.findUnique.mockResolvedValue(detailRow({ statusHistory: [] }));

      const { data } = await service.getOne('ord_1');

      expect(data.statusHistory).toEqual([
        {
          id: 'sys_created_ord_1',
          status: 'pending_payment',
          note: 'Order created',
          actor: { type: 'SYSTEM', id: null, name: 'System' },
          createdAt: '2026-07-20T10:00:00.000Z',
        },
      ]);
    });

    it('returns shippingAddress null for a pickup order (no address)', async () => {
      prisma.order.findUnique.mockResolvedValue(detailRow({ deliveryAddress: null }));

      const { data } = await service.getOne('ord_1');

      expect(data.shippingAddress).toBeNull();
    });
  });
});

describe('ListAdminOrdersQueryDto validation', () => {
  it('accepts whitelisted sortBy/order', () => {
    const dto = plainToInstance(ListAdminOrdersQueryDto, { sortBy: 'status', order: 'asc' });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects an unsupported sortBy (→ 400 via ValidationPipe)', () => {
    const dto = plainToInstance(ListAdminOrdersQueryDto, { sortBy: 'id; DROP TABLE' });
    const errors = validateSync(dto);
    expect(errors).not.toHaveLength(0);
    expect(errors[0].property).toBe('sortBy');
  });

  it('rejects an invalid order direction', () => {
    const dto = plainToInstance(ListAdminOrdersQueryDto, { order: 'sideways' });
    const errors = validateSync(dto);
    expect(errors).not.toHaveLength(0);
    expect(errors[0].property).toBe('order');
  });
});
