/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// Where the operator sees a pickup order collected (GET /v1/admin/orders/:id): each dealer
// the order recorded, its address and coordinates, and the lines that are its own. And that
// this holds for an order placed through the real checkout path, from the dealer each line
// was recorded under when it was placed.

import { DeliveryMethod, OrderStatus } from '@prisma/client';
import { matchesWhere } from '../../catalog/compatibility/where-eval.test-util';
import { OrderStatusService } from '../../orders/order-status.service';
import { OrdersService } from '../../orders/orders.service';
import { PickupPointsService } from '../../shipping/pickup-points.service';
import {
  buildCart,
  buildCartItem,
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeDiscounts,
  fakeNotifications,
  fakeRealtime,
  PrismaMock,
} from '../../../test/utils/harness';
import { AdminOrdersService } from './admin-orders.service';

type Row = Record<string, unknown>;

/** A table that answers findMany by its `where`, as the database would. */
const table = (rows: Row[]) =>
  jest.fn((args?: { where?: unknown }) =>
    Promise.resolve(rows.filter((row) => matchesWhere(row, args?.where))),
  );

const STOREFRONTS: Row[] = [
  { id: 'drivers-village', name: 'Driver’s Village', internalSellerId: null },
  { id: 'seller_7', name: 'Avto Ehtiyot', internalSellerId: 7 },
  { id: 'seller_9', name: 'Chilonzor Parts', internalSellerId: 9 },
];

const SELLERS: Row[] = [
  {
    id: 5,
    tgId: null,
    catalogSellerId: 'drivers-village',
    storeName: 'DV',
    marketName: null,
    addressComment: 'Toshkent, Bunyodkor shoh ko‘chasi 12',
    locationLat: 41.2851,
    locationLng: 69.2045,
  },
  {
    id: 7,
    tgId: BigInt(7007),
    catalogSellerId: null,
    storeName: 'Avto Ehtiyot',
    marketName: null,
    addressComment: 'Sergeli avtobozori, 3-qator 25',
    locationLat: 41.2263,
    locationLng: 69.219,
  },
  {
    id: 9,
    tgId: BigInt(9009),
    catalogSellerId: null,
    storeName: 'Chilonzor Parts',
    marketName: null,
    addressComment: 'Chilonzor 9-kvartal',
    locationLat: 41.2756,
    locationLng: 69.2034,
  },
];

const orderLine = (
  id: string,
  sellerId: string | null,
  over: Row = {},
): Row => ({
  id,
  partId: `part_${id}`,
  title: `Line ${id}`,
  quantity: 1,
  priceUzs: 100_000,
  lineTotalUzs: 100_000,
  sellerId,
  providerId: null,
  offerId: null,
  serviceId: null,
  offerSellerTgId: null,
  ...over,
});

const detail = (over: Row = {}): Row => ({
  id: 'ord_1',
  status: OrderStatus.PAID,
  totalUzs: 305_000,
  subtotalUzs: 300_000,
  discountUzs: 0,
  serviceFeeUzs: 5_000,
  deliveryUzs: 0,
  paymentType: 'CASH',
  refundSettledAt: null,
  deliveryMethod: DeliveryMethod.PICKUP,
  deliveryDestination: null,
  createdAt: new Date('2026-11-07T10:00:00.000Z'),
  updatedAt: new Date('2026-11-07T10:00:00.000Z'),
  user: {
    id: 'usr_1',
    displayName: 'Ali Valiyev',
    firstName: null,
    lastName: null,
    phoneE164: '+998903700340',
    email: null,
  },
  deliveryAddress: null,
  items: [],
  payments: [],
  statusHistory: [],
  ...over,
});

function adminService(
  order: Row,
  tables: { sellers?: Row[]; storefronts?: Row[] } = {},
) {
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    catalogSeller: { findMany: table(tables.storefronts ?? STOREFRONTS) },
    seller: { findMany: table(tables.sellers ?? SELLERS) },
    catalogPart: { findMany: jest.fn() },
  };
  const service = new AdminOrdersService(
    prisma as never,
    {
      get: () => undefined,
    } as never,
  );
  return { prisma, service };
}

describe('Admin order detail: where a pickup order is collected', () => {
  it('each dealer the order recorded, with its address, coordinates and only its own lines', async () => {
    const { service } = adminService(
      detail({
        items: [
          orderLine('oi_1', 'drivers-village', { quantity: 2 }),
          orderLine('oi_2', 'seller_7'),
          orderLine('oi_3', 'drivers-village'),
        ],
      }),
    );

    const { data } = await service.getOne('ord_1');

    expect(data.deliveryMethod).toBe('pickup');
    expect(data.pickupPoints).toEqual([
      {
        dealerId: 'drivers-village',
        dealerName: 'Driver’s Village',
        address: 'Toshkent, Bunyodkor shoh ko‘chasi 12',
        landmark: null,
        location: { lat: 41.2851, lng: 69.2045 },
        items: [
          {
            id: 'oi_1',
            productId: 'part_oi_1',
            title: 'Line oi_1',
            quantity: 2,
          },
          {
            id: 'oi_3',
            productId: 'part_oi_3',
            title: 'Line oi_3',
            quantity: 1,
          },
        ],
      },
      {
        dealerId: 'seller_7',
        dealerName: 'Avto Ehtiyot',
        address: 'Sergeli avtobozori, 3-qator 25',
        landmark: null,
        location: { lat: 41.2263, lng: 69.219 },
        items: [
          {
            id: 'oi_2',
            productId: 'part_oi_2',
            title: 'Line oi_2',
            quantity: 1,
          },
        ],
      },
    ]);
    // A dealer with nothing in this order is nowhere in it.
    expect(JSON.stringify(data.pickupPoints)).not.toContain('Chilonzor');
  });

  it('the dealer is the one recorded on the order, not looked up again from the part', async () => {
    const { service, prisma } = adminService(
      detail({ items: [orderLine('oi_1', 'seller_7')] }),
    );

    await service.getOne('ord_1');

    expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
  });

  it('a dealer with no location on record has no coordinates: never a default', async () => {
    const { service } = adminService(
      detail({ items: [orderLine('oi_1', 'seller_7')] }),
      {
        sellers: SELLERS.map((s) =>
          s.id === 7
            ? {
                ...s,
                addressComment: null,
                locationLat: null,
                locationLng: null,
              }
            : s,
        ),
      },
    );

    const { data } = await service.getOne('ord_1');

    expect(data.pickupPoints).toEqual([
      expect.objectContaining({
        dealerId: 'seller_7',
        address: null,
        location: null,
      }),
    ]);
  });

  it('a line recorded with no dealer is listed apart, with no point; a service line not at all', async () => {
    const { service } = adminService(
      detail({
        items: [
          orderLine('oi_1', null),
          orderLine('oi_2', 'seller_7'),
          orderLine('oi_3', null, {
            partId: null,
            serviceId: 'svc_1',
            providerId: 'prov_1',
          }),
        ],
      }),
    );

    const { data } = await service.getOne('ord_1');

    expect(data.pickupPoints?.map((p) => p.dealerId)).toEqual([
      'seller_7',
      null,
    ]);
    expect(data.pickupPoints?.[1]).toEqual({
      dealerId: null,
      dealerName: null,
      address: null,
      landmark: null,
      location: null,
      items: [
        { id: 'oi_1', productId: 'part_oi_1', title: 'Line oi_1', quantity: 1 },
      ],
    });
  });

  it('a courier order has no pickup points, and reads no seller for them', async () => {
    const { service, prisma } = adminService(
      detail({
        deliveryMethod: DeliveryMethod.COURIER,
        items: [orderLine('oi_1', 'seller_7')],
      }),
    );

    const { data } = await service.getOne('ord_1');

    expect(data.deliveryMethod).toBe('courier');
    expect(data.pickupPoints).toBeNull();
    expect(prisma.seller.findMany).not.toHaveBeenCalled();
    // The settlement's names are read exactly as before.
    expect(prisma.catalogSeller.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.catalogSeller.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['seller_7'] } },
      select: { id: true, name: true },
    });
  });
});

describe('A pickup order placed through checkout keeps its dealers and their places', () => {
  let prisma: PrismaMock;
  let orders: OrdersService;
  let quotes: { quote: jest.Mock };

  const PARTS = [
    {
      id: 'part_dv_1',
      sellerId: 'drivers-village',
      inStock: true,
      priceUzs: 100_000,
      categoryId: 'cat_1',
      seller: { status: 'ACTIVE' },
    },
    {
      id: 'part_7_1',
      sellerId: 'seller_7',
      inStock: true,
      priceUzs: 100_000,
      categoryId: 'cat_1',
      seller: { status: 'ACTIVE' },
    },
  ];
  const CART_LINES = [
    buildCartItem({
      id: 'ci_1',
      partId: 'part_dv_1',
      title: 'Колодки',
      priceUzsSnapshot: 100_000,
      quantity: 2,
    }),
    buildCartItem({
      id: 'ci_2',
      partId: 'part_7_1',
      title: 'Фильтр',
      priceUzsSnapshot: 100_000,
    }),
  ];

  beforeEach(() => {
    prisma = createPrismaMock();
    quotes = { quote: jest.fn() };
    orders = new OrdersService(
      prisma,
      fakeConfig(),
      fakeNotifications(),
      fakeRealtime(),
      new OrderStatusService(prisma),
      fakeDiscounts(),
      { record: jest.fn() } as never,
      quotes as never,
    );
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({ id: 'cart_1', userId: 'usr_1', items: CART_LINES }),
    );
    prisma.catalogPart.findMany.mockResolvedValue(PARTS);
    prisma.catalogSeller.findMany.mockImplementation(table(STOREFRONTS));
    prisma.seller.findMany.mockImplementation(table(SELLERS));
    prisma.order.create.mockResolvedValue(buildOrder({ id: 'ord_1' }));
  });

  it('shows the operator the same dealers the checkout showed, each with its own lines', async () => {
    // What the buyer was shown before placing it.
    const shown = await new PickupPointsService(prisma).forCart('usr_1');

    await orders.createFromCart('usr_1', {
      cart_snapshot: { delivery_method: 'pickup' },
      payment_type: 'cash',
    });

    expect(quotes.quote).not.toHaveBeenCalled();
    const created = prisma.order.create.mock.calls[0][0].data;
    expect(created.deliveryMethod).toBe('PICKUP');
    // The dealer of each line, recorded with the order.
    expect(
      created.items.create.map((i: Row) => [i.partId, i.sellerId]),
    ).toEqual([
      ['part_dv_1', 'drivers-village'],
      ['part_7_1', 'seller_7'],
    ]);

    const { service } = adminService(
      detail({
        deliveryMethod: created.deliveryMethod,
        items: created.items.create.map((i: Row) => ({
          id: i.id,
          partId: i.partId,
          title: i.title,
          quantity: i.quantity,
          priceUzs: i.priceUzs,
          lineTotalUzs: i.lineTotalUzs,
          sellerId: i.sellerId,
          providerId: i.providerId,
          offerId: i.offerId,
          serviceId: i.serviceId,
          offerSellerTgId: i.offerSellerTgId,
        })),
      }),
    );
    const { data } = await service.getOne('ord_1');

    expect(data.pickupPoints).toEqual([
      expect.objectContaining({
        dealerId: 'drivers-village',
        dealerName: 'Driver’s Village',
        address: 'Toshkent, Bunyodkor shoh ko‘chasi 12',
        location: { lat: 41.2851, lng: 69.2045 },
        items: [
          expect.objectContaining({
            productId: 'part_dv_1',
            title: 'Колодки',
            quantity: 2,
          }),
        ],
      }),
      expect.objectContaining({
        dealerId: 'seller_7',
        dealerName: 'Avto Ehtiyot',
        address: 'Sergeli avtobozori, 3-qator 25',
        location: { lat: 41.2263, lng: 69.219 },
        items: [
          expect.objectContaining({
            productId: 'part_7_1',
            title: 'Фильтр',
            quantity: 1,
          }),
        ],
      }),
    ]);
    // Dealer by dealer, what the checkout showed.
    expect(
      data.pickupPoints?.map((p) => [p.dealerId, p.address, p.location]),
    ).toEqual(shown.map((p) => [p.dealerId, p.address, p.location]));
    expect(
      data.pickupPoints?.map((p) => p.items.map((i) => i.productId)),
    ).toEqual(shown.map((p) => p.items.map((i) => i.partId)));
  });
});
