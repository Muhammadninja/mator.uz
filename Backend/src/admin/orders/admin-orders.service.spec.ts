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
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(prisma);
  return prisma as {
    order: typeof order;
    $transaction: (arg: unknown) => unknown;
  };
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
      {
        id: 'oi_1',
        partId: 'part_1',
        title: 'Brake pad',
        quantity: 2,
        priceUzs: 120000,
        lineTotalUzs: 240000,
      },
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
    service = new AdminOrdersService(
      prisma as never,
      {
        get: () => undefined,
      } as never,
    );
  });

  describe('list', () => {
    it('returns correct pagination meta and computes offset from page/limit', async () => {
      prisma.order.findMany.mockResolvedValue([listRow()]);
      prisma.order.count.mockResolvedValue(142);

      const res = await service.list({ page: 2, limit: 20 });

      expect(res.meta).toEqual({
        page: 2,
        limit: 20,
        totalItems: 142,
        totalPages: 8,
      });
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
        expect.objectContaining({
          skip: 0,
          take: 20,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        }),
      );
      expect(res.meta).toEqual({
        page: 1,
        limit: 20,
        totalItems: 0,
        totalPages: 0,
      });
    });

    it('clamps a limit above 100 down to 100', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      const res = await service.list({ limit: 500 });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
      expect(res.meta.limit).toBe(100);
    });

    it('maps the totalAmount sort onto the real totalUzs column', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.list({ sortBy: 'totalAmount', order: 'asc' });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ totalUzs: 'asc' }, { id: 'asc' }],
        }),
      );
    });

    it("filters to one customer's orders, so an older history can be reached", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);
      const customerId = '00000000-0000-4000-8000-000000000001';

      await service.list({ customerId });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: customerId }),
        }),
      );
    });

    it('applies no status filter for status=all', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.list({ status: 'all' });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('parses a comma-separated status filter into where.status.in', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.list({ status: 'pending_payment, paid' });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.PAID] },
          },
        }),
      );
    });

    it('rejects an unknown status token with 400', async () => {
      await expect(
        service.list({ status: 'pending_payment,confirmed' }),
      ).rejects.toBeInstanceOf(BadRequestException);
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
              {
                user: {
                  displayName: {
                    contains: '+998903700340',
                    mode: 'insensitive',
                  },
                },
              },
              {
                user: {
                  firstName: { contains: '+998903700340', mode: 'insensitive' },
                },
              },
              {
                user: {
                  lastName: { contains: '+998903700340', mode: 'insensitive' },
                },
              },
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
              {
                user: { displayName: { contains: 'Ali', mode: 'insensitive' } },
              },
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
        slaOverdue: false,
        operatorWarning: false,
        refundDue: false,
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

    it.each(['CASH', 'TERMINAL'])(
      'shows the method a %s order was placed with: it never gets a payment row',
      async (paymentType) => {
        prisma.order.findMany.mockResolvedValue([
          listRow({ payments: [], paymentType }),
        ]);
        prisma.order.count.mockResolvedValue(1);

        const res = await service.list({});

        expect(res.data[0].paymentMethod).toBe(paymentType.toLowerCase());
        expect(res.data[0].paymentStatus).toBeNull();
      },
    );
  });

  describe('getOne', () => {
    it('reports the delivery method the order holds, not one guessed from the address', async () => {
      prisma.order.findUnique.mockResolvedValue(
        detailRow({ deliveryMethod: 'COURIER', deliveryAddress: null }),
      );

      const res = await service.getOne('ord_1');

      expect(res.data.deliveryMethod).toBe('courier');
      expect(res.data.shippingAddress).toBeNull();
    });

    it('404s on an unknown order', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.getOne('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
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
      expect(
        data.statusHistory.map((h: { status: string }) => h.status),
      ).toEqual(['pending_payment', 'paid', 'processing']);
      expect(data.statusHistory[0].actor).toEqual({
        type: 'SYSTEM',
        id: null,
        name: 'System',
      });
      expect(data.statusHistory[2].actor).toEqual({
        type: 'ADMIN',
        id: 'usr_admin',
        name: 'Operator One',
      });
    });

    it('synthesizes a single SYSTEM creation entry only for a legacy order with no history rows', async () => {
      prisma.order.findUnique.mockResolvedValue(
        detailRow({ statusHistory: [] }),
      );

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

    describe('where the courier goes', () => {
      const CONFIRMED = {
        addressId: 'addr_1',
        lat: 41.311081234,
        lng: 69.240562987,
        label: 'Work',
        fullText: 'What it said when ordered',
        regionCode: 'UZ-TK',
        district: 'Chilonzor',
        street: 'Bunyodkor 1',
        landmark: 'Blue gate',
      };
      const AS_CONFIRMED = {
        city: 'UZ-TK',
        district: 'Chilonzor',
        addressLine: 'What it said when ordered',
        landmark: 'Blue gate',
        location: { lat: 41.311081234, lng: 69.240562987 },
      };

      it('is the destination confirmed on the order, not what the address row says now', async () => {
        prisma.order.findUnique.mockResolvedValue(
          detailRow({ deliveryDestination: CONFIRMED }),
        );

        const { data } = await service.getOne('ord_1');

        expect(data.shippingAddress).toEqual(AS_CONFIRMED);
      });

      it('survives the buyer deleting the address after ordering', async () => {
        prisma.order.findUnique.mockResolvedValue(
          detailRow({ deliveryAddress: null, deliveryDestination: CONFIRMED }),
        );

        const { data } = await service.getOne('ord_1');

        expect(data.shippingAddress).toEqual(AS_CONFIRMED);
      });

      it('shows a pin with no words at all, by its exact point', async () => {
        prisma.order.findUnique.mockResolvedValue(
          detailRow({
            deliveryDestination: {
              ...CONFIRMED,
              fullText: '41.311081234, 69.240562987',
              regionCode: null,
              district: null,
              street: null,
              landmark: null,
            },
          }),
        );

        const { data } = await service.getOne('ord_1');

        expect(data.shippingAddress).toEqual({
          city: null,
          district: null,
          addressLine: '41.311081234, 69.240562987',
          landmark: null,
          location: { lat: 41.311081234, lng: 69.240562987 },
        });
      });

      it.each([
        ['an order from before the snapshot', null],
        ['a snapshot with no point', { fullText: 'Somewhere' }],
      ])(
        'falls back on the address row for %s',
        async (_, deliveryDestination) => {
          prisma.order.findUnique.mockResolvedValue(
            detailRow({ deliveryDestination }),
          );

          const { data } = await service.getOne('ord_1');

          expect(data.shippingAddress?.location).toEqual({
            lat: 41.31,
            lng: 69.27,
          });
          expect(data.shippingAddress?.addressLine).toBe(
            'Amir Temur 12, Yunusabad, Tashkent',
          );
        },
      );
    });

    it('returns shippingAddress null for a pickup order (no address)', async () => {
      prisma.order.findUnique.mockResolvedValue(
        detailRow({ deliveryAddress: null }),
      );

      const { data } = await service.getOne('ord_1');

      expect(data.shippingAddress).toBeNull();
    });
  });
});

describe('ListAdminOrdersQueryDto validation', () => {
  it('accepts whitelisted sortBy/order', () => {
    const dto = plainToInstance(ListAdminOrdersQueryDto, {
      sortBy: 'status',
      order: 'asc',
    });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects an unsupported sortBy (→ 400 via ValidationPipe)', () => {
    const dto = plainToInstance(ListAdminOrdersQueryDto, {
      sortBy: 'id; DROP TABLE',
    });
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

describe('AdminOrdersService — Mator’s money and the sellers’', () => {
  const config = { get: () => undefined } as never;

  it('order detail: each charge apart, and what each seller is owed without the fee or delivery', async () => {
    const order = {
      findUnique: jest.fn().mockResolvedValue(
        detailRow({
          subtotalUzs: 600_000,
          discountUzs: 0,
          serviceFeeUzs: 20_000,
          deliveryUzs: 25_000,
          totalUzs: 645_000,
          items: [
            {
              id: 'oi_1',
              partId: 'part_1',
              title: 'Колодки',
              quantity: 1,
              priceUzs: 350_000,
              lineTotalUzs: 350_000,
              sellerId: 'dealer_a',
              providerId: null,
            },
            {
              id: 'oi_2',
              partId: 'part_2',
              title: 'Фильтр',
              quantity: 1,
              priceUzs: 250_000,
              lineTotalUzs: 250_000,
              sellerId: 'dealer_b',
              providerId: null,
            },
          ],
        }),
      ),
    };
    const catalogSeller = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'dealer_a', name: 'Driver’s Village' },
        { id: 'dealer_b', name: 'Avto Ehtiyot' },
      ]),
    };
    const service = new AdminOrdersService(
      { order, catalogSeller } as never,
      config,
    );

    const { data } = await service.getOne('ord_1');

    expect(data).toMatchObject({
      itemsSubtotal: 600_000,
      discount: 0,
      serviceFee: 20_000,
      deliveryFee: 25_000,
      totalAmount: 645_000,
      settlement: {
        sellers: [
          { sellerId: 'dealer_a', name: 'Driver’s Village', amount: 350_000 },
          { sellerId: 'dealer_b', name: 'Avto Ehtiyot', amount: 250_000 },
        ],
        providers: [],
        unattributed: 0,
        matorServiceFee: 20_000,
        delivery: 25_000,
        total: 645_000,
      },
    });
    expect(catalogSeller.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['dealer_a', 'dealer_b'] } },
      select: { id: true, name: true },
    });
  });

  it('dashboard totals: the fee Mator kept, net of what refunds gave back', async () => {
    const prisma = {
      order: {
        groupBy: jest.fn().mockResolvedValue([
          {
            status: OrderStatus.DELIVERED,
            _count: { _all: 2 },
            _sum: { totalUzs: 1_290_000, serviceFeeUzs: 40_000 },
          },
          {
            status: OrderStatus.PENDING_PAYMENT,
            _count: { _all: 1 },
            _sum: { totalUzs: 155_000, serviceFeeUzs: 5_000 },
          },
        ]),
        count: jest.fn().mockResolvedValue(0),
      },
      financialRefund: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { serviceFeeUzs: 20_000 } }),
      },
    };
    const service = new AdminOrdersService(prisma as never, config);

    const { data } = await service.summary();

    // An unpaid order earns nothing yet; a returned fee is no longer Mator's.
    expect(data).toMatchObject({
      revenueUzs: 1_290_000,
      serviceFeeRevenueUzs: 20_000,
    });
    expect(prisma.financialRefund.aggregate).toHaveBeenCalledWith({
      where: {
        voidedAt: null,
        order: {
          status: {
            in: [
              OrderStatus.PAID,
              OrderStatus.PROCESSING,
              OrderStatus.SHIPPED,
              OrderStatus.DELIVERED,
            ],
          },
        },
      },
      _sum: { serviceFeeUzs: true },
    });
  });
});
