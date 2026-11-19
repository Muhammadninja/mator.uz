/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// Where the buyer collects their own pickup order (GET /v1/orders/:id): each dealer the
// order recorded, with the address and place the checkout showed, and only its own lines.
// A courier order has none and reads no seller for them.

import { NotFoundException } from '@nestjs/common';
import { OrderStatusService } from './order-status.service';
import { OrdersService } from './orders.service';
import {
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeDiscounts,
  fakeNotifications,
  fakeRealtime,
  PrismaMock,
} from '../../test/utils/harness';

const line = (
  id: string,
  sellerId: string | null,
  over: Record<string, unknown> = {},
) => ({
  id,
  orderId: 'ord_1',
  partId: `part_${id}`,
  serviceId: null,
  providerId: null,
  offerId: null,
  offerSellerTgId: null,
  sellerId,
  title: `Line ${id}`,
  quantity: 2,
  priceUzs: 100_000,
  lineTotalUzs: 200_000,
  scheduledAt: null,
  ...over,
});

describe("The buyer's own pickup order says where to collect it", () => {
  let prisma: PrismaMock;
  let service: OrdersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new OrdersService(
      prisma,
      fakeConfig(),
      fakeNotifications(),
      fakeRealtime(),
      new OrderStatusService(prisma),
      fakeDiscounts(),
      { record: jest.fn() } as never,
      { quote: jest.fn() } as never,
    );
    prisma.catalogSeller.findMany.mockResolvedValue([
      { id: 'seller_7', name: 'Avto Ehtiyot', internalSellerId: 7 },
    ]);
    prisma.seller.findMany.mockResolvedValue([
      {
        id: 7,
        tgId: null,
        catalogSellerId: null,
        storeName: 'Avto Ehtiyot',
        marketName: null,
        addressComment: 'Sergeli avtobozori, 3-qator 25',
        locationLat: 41.2263,
        locationLng: 69.219,
      },
    ]);
  });

  it('lists each dealer with its address, place and own lines', async () => {
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({
        id: 'ord_1',
        userId: 'usr_1',
        status: 'DELIVERED',
        deliveryMethod: 'PICKUP',
        items: [
          line('oi_1', 'seller_7'),
          // A service is done at its provider: nothing to collect.
          line('oi_2', null, { partId: null, serviceId: 'svc_1' }),
        ],
      }),
    );

    const res = await service.getOrder('usr_1', 'ord_1');

    expect(res).toHaveProperty('pickup_points', [
      {
        dealer_id: 'seller_7',
        dealer_name: 'Avto Ehtiyot',
        address: 'Sergeli avtobozori, 3-qator 25',
        landmark: null,
        location: { lat: 41.2263, lng: 69.219 },
        items: [
          {
            order_item_id: 'oi_1',
            part_id: 'part_oi_1',
            title: 'Line oi_1',
            quantity: 2,
          },
        ],
      },
    ]);
    expect(prisma.catalogSeller.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['seller_7'] } } }),
    );
  });

  it('a courier order has none, and reads no seller', async () => {
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({
        id: 'ord_1',
        userId: 'usr_1',
        items: [line('oi_1', 'seller_7')],
      }),
    );

    const res = await service.getOrder('usr_1', 'ord_1');

    expect(res).not.toHaveProperty('pickup_points');
    expect(prisma.seller.findMany).not.toHaveBeenCalled();
    expect(prisma.catalogSeller.findMany).not.toHaveBeenCalled();
  });

  it("another buyer's pickup order is not found, and reads no seller", async () => {
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({
        id: 'ord_1',
        userId: 'usr_2',
        deliveryMethod: 'PICKUP',
        items: [line('oi_1', 'seller_7')],
      }),
    );

    await expect(service.getOrder('usr_1', 'ord_1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.seller.findMany).not.toHaveBeenCalled();
  });

  it('the list carries no pickup points', async () => {
    prisma.order.findMany.mockResolvedValue([
      buildOrder({
        id: 'ord_1',
        userId: 'usr_1',
        deliveryMethod: 'PICKUP',
        items: [line('oi_1', 'seller_7')],
      }),
    ]);

    const res = await service.list('usr_1', {});

    expect(res.items[0]).not.toHaveProperty('pickup_points');
    expect(prisma.seller.findMany).not.toHaveBeenCalled();
  });
});
