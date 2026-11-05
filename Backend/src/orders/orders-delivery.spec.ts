/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// What a courier order charges for delivery: always the backend's own figure, agreed to
// by the buyer, and fixed from the moment the order exists.

import {
  ServiceUnavailableException,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreateOrderDto } from './dto/create-order.dto';
import { presentOrder } from './order.presenter';
import { OrderStatusService } from './order-status.service';
import { OrdersService } from './orders.service';
import { DELIVERY_TITLE } from './webhooks/payme-fiscal.service';
import { receiptTotalTiyin } from './webhooks/payme-fiscal.util';
import {
  buildCart,
  buildCartItem,
  buildOrder,
  createPrismaMock,
  fakeConfig,
  fakeDiscounts,
  fakeFiscal,
  fakeNotifications,
  fakeRealtime,
  PrismaMock,
  stubFiscalizableOrderLines,
} from '../../test/utils/harness';

const DESTINATION = {
  addressId: 'addr_1',
  lat: 41.31310000049,
  lng: 69.28700000049,
  label: 'Work',
  fullText: 'Amir Temur 12, Toshkent',
  regionCode: null,
  district: 'Yunusobod',
  street: 'Amir Temur 12',
  landmark: 'Blue gate',
};
const QUOTE = {
  priceUzs: 37_500,
  quoteId: 'quote_for_these_points',
  destination: DESTINATION,
  shipments: [
    {
      sellerId: 1,
      pickup: { lat: 41.2995, lng: 69.2401 },
      tariffVersion: 'tariff_1',
      distanceMeters: 500,
      billableKm: 1,
      priceUzs: 5_000,
    },
    {
      sellerId: 2,
      pickup: { lat: 41.2, lng: 69.2 },
      tariffVersion: 'tariff_1',
      distanceMeters: 10_100,
      billableKm: 11,
      priceUzs: 32_500,
    },
  ],
};

const COURIER = {
  cart_snapshot: { delivery_method: 'courier', delivery_address_id: 'addr_1' },
  confirmed_delivery_uzs: 37_500,
  delivery_quote_id: 'quote_for_these_points',
};

describe('Courier delivery on an order', () => {
  let prisma: PrismaMock;
  let quotes: { quote: jest.Mock };
  let service: OrdersService;

  const created = () => prisma.order.create.mock.calls[0][0].data;

  beforeEach(() => {
    prisma = createPrismaMock();
    quotes = { quote: jest.fn().mockResolvedValue(QUOTE) };
    service = new OrdersService(
      prisma,
      fakeConfig(),
      fakeNotifications(),
      fakeRealtime(),
      new OrderStatusService(prisma),
      fakeDiscounts(),
      { record: jest.fn() } as never,
      quotes as never,
    );
    prisma.address.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'usr_1',
    });
    prisma.catalogPart.findMany.mockResolvedValue([
      {
        id: 'part_1',
        inStock: true,
        priceUzs: 185_000,
        seller: { status: 'ACTIVE' },
        categoryId: 'cat_1',
        sellerId: 'seller_1',
      },
    ]);
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({
        id: 'cart_1',
        userId: 'usr_1',
        items: [buildCartItem({ partId: 'part_1', priceUzsSnapshot: 185_000 })],
      }),
    );
    prisma.order.create.mockResolvedValue(buildOrder({ id: 'ord_1' }));
  });

  it('charges the computed price, adds it to the total, and keeps how it was reached', async () => {
    await service.createFromCart('usr_1', COURIER);

    expect(quotes.quote).toHaveBeenCalledWith(
      'usr_1',
      'addr_1',
      expect.arrayContaining([expect.objectContaining({ partId: 'part_1' })]),
    );
    expect(created()).toMatchObject({
      deliveryMethod: 'COURIER',
      deliveryAddressId: 'addr_1',
      subtotalUzs: 185_000,
      deliveryUzs: 37_500,
      serviceFeeUzs: 0,
      totalUzs: 222_500,
      deliveryShipments: QUOTE.shipments,
    });
    expect(prisma.cartItem.deleteMany).toHaveBeenCalled();
  });

  it('keeps a copy of the exact destination on the order, words and all', async () => {
    await service.createFromCart('usr_1', COURIER);

    expect(created().deliveryDestination).toEqual(DESTINATION);
  });

  it('keeps each pickup and the tariff too', async () => {
    await service.createFromCart('usr_1', COURIER);

    for (const shipment of created().deliveryShipments) {
      expect(shipment.tariffVersion).toBe('tariff_1');
    }
    expect(created().deliveryShipments[1].pickup).toEqual({
      lat: 41.2,
      lng: 69.2,
    });
  });

  it('stores no duration or geometry on the order', async () => {
    await service.createFromCart('usr_1', COURIER);

    expect(JSON.stringify(created().deliveryShipments)).not.toMatch(
      /duration|geometry|"eta/i,
    );
  });

  describe('a quote for something other than this delivery', () => {
    it('after the buyer moved the saved destination: a new quote, even at the same price', async () => {
      quotes.quote.mockResolvedValue({
        ...QUOTE,
        quoteId: 'quote_for_the_new_point',
      });

      await expect(
        service.createFromCart('usr_1', COURIER),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'DELIVERY_QUOTE_STALE' },
      });
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.cartItem.deleteMany).not.toHaveBeenCalled();
    });

    it('a quote id made up in the request gets no further', async () => {
      await expect(
        service.createFromCart('usr_1', {
          ...COURIER,
          delivery_quote_id: 'made_up',
        }),
      ).rejects.toMatchObject({ response: { code: 'DELIVERY_QUOTE_STALE' } });
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('a price with no quote id has agreed to nothing: refused before any routing', async () => {
      await expect(
        service.createFromCart('usr_1', {
          cart_snapshot: COURIER.cart_snapshot,
          confirmed_delivery_uzs: 37_500,
        }),
      ).rejects.toMatchObject({
        response: { code: 'DELIVERY_COST_UNAVAILABLE' },
      });
      expect(quotes.quote).not.toHaveBeenCalled();
    });
  });

  it('a promo discounts the goods only, never the delivery', async () => {
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({
        id: 'cart_1',
        userId: 'usr_1',
        promoCode: 'MATOR10',
        items: [buildCartItem({ partId: 'part_1', priceUzsSnapshot: 200_000 })],
      }),
    );
    prisma.catalogPart.findMany.mockResolvedValue([
      {
        id: 'part_1',
        inStock: true,
        priceUzs: 200_000,
        seller: { status: 'ACTIVE' },
        categoryId: 'cat_1',
        sellerId: 'seller_1',
      },
    ]);

    await service.createFromCart('usr_1', COURIER);

    expect(created()).toMatchObject({
      subtotalUzs: 200_000,
      discountUzs: 20_000,
      deliveryUzs: 37_500,
      totalUzs: 217_500,
    });
    expect(created().items.create[0].lineTotalUzs).toBe(180_000);
  });

  describe('a price the backend did not compute cannot be charged', () => {
    it.each([
      ['lowered', 1],
      ['zeroed', 0],
      ['raised', 999_999],
    ])(
      '%s in the request: refused, nothing created, cart kept',
      async (_, price) => {
        await expect(
          service.createFromCart('usr_1', {
            ...COURIER,
            confirmed_delivery_uzs: price,
          }),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'DELIVERY_PRICE_CHANGED' },
        });
        expect(prisma.order.create).not.toHaveBeenCalled();
        expect(prisma.cartItem.deleteMany).not.toHaveBeenCalled();
      },
    );

    it('a stale price, after the cart or the rates changed, is refused the same way', async () => {
      quotes.quote.mockResolvedValue({ ...QUOTE, priceUzs: 40_000 });
      await expect(
        service.createFromCart('usr_1', COURIER),
      ).rejects.toMatchObject({ response: { code: 'DELIVERY_PRICE_CHANGED' } });
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it.each([
      ['no price', {}],
      ['a null price', { confirmed_delivery_uzs: null }],
    ])(
      'a client stating %s has shown none: refused before any routing',
      async (_, stated) => {
        await expect(
          service.createFromCart('usr_1', {
            cart_snapshot: COURIER.cart_snapshot,
            delivery_quote_id: COURIER.delivery_quote_id,
            ...stated,
          } as never),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'DELIVERY_COST_UNAVAILABLE' },
        });
        expect(quotes.quote).not.toHaveBeenCalled();
        expect(prisma.order.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('when no price can be had', () => {
    it.each([
      [new UnprocessableEntityException({ code: 'PICKUP_LOCATION_MISSING' })],
      [
        new ServiceUnavailableException({
          code: 'DELIVERY_ROUTING_UNAVAILABLE',
        }),
      ],
    ])('%s: nothing is created and the cart is kept', async (refusal) => {
      quotes.quote.mockRejectedValue(refusal);

      await expect(service.createFromCart('usr_1', COURIER)).rejects.toBe(
        refusal,
      );

      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.cartItem.deleteMany).not.toHaveBeenCalled();
    });

    it('prices before the transaction, so no network call holds it open', async () => {
      const order: string[] = [];
      quotes.quote.mockImplementation(() => {
        order.push('quote');
        return Promise.resolve(QUOTE);
      });
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
        order.push('transaction');
        return fn(prisma);
      });

      await service.createFromCart('usr_1', COURIER);

      expect(order).toEqual(['quote', 'transaction']);
    });
  });

  describe('pickup', () => {
    it.each([undefined, 37_500])(
      'costs nothing and routes nothing, whatever the request claims (%p)',
      async (confirmed) => {
        await service.createFromCart('usr_1', {
          cart_snapshot: {
            delivery_method: 'pickup',
            delivery_address_id: 'addr_1',
          },
          confirmed_delivery_uzs: confirmed,
        });

        expect(quotes.quote).not.toHaveBeenCalled();
        expect(created()).toMatchObject({
          deliveryMethod: 'PICKUP',
          deliveryUzs: 0,
          totalUzs: 185_000,
        });
        expect(created()).not.toHaveProperty('deliveryShipments');
        expect(created()).not.toHaveProperty('deliveryDestination');
      },
    );
  });

  it('a cart of services alone needs no price, even sent by courier', async () => {
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({
        id: 'cart_1',
        userId: 'usr_1',
        items: [
          buildCartItem({
            partId: null,
            serviceId: 'svc_1',
            priceUzsSnapshot: 100_000,
          }),
        ],
      }),
    );

    await service.createFromCart('usr_1', {});

    expect(quotes.quote).not.toHaveBeenCalled();
    expect(created()).toMatchObject({ deliveryUzs: 0, totalUzs: 100_000 });
  });

  describe('after the order exists', () => {
    const placed = buildOrder({
      id: 'ord_1',
      userId: 'usr_1',
      deliveryUzs: 37_500,
      deliveryShipments: QUOTE.shipments,
      deliveryDestination: DESTINATION,
      totalUzs: 222_500,
    });

    it('viewing it reads the stored price and computes nothing', async () => {
      prisma.order.findUnique.mockResolvedValue(placed);

      const res = await service.getOrder('usr_1', 'ord_1');

      expect(res.delivery_uzs).toBe(37_500);
      expect(quotes.quote).not.toHaveBeenCalled();
    });

    it('listing them does neither', async () => {
      prisma.order.findMany.mockResolvedValue([placed]);

      const res = await service.list('usr_1', {});

      expect(res.items[0].delivery_uzs).toBe(37_500);
      expect(quotes.quote).not.toHaveBeenCalled();
    });

    it('the buyer sees the price, never how it was reached', () => {
      expect(JSON.stringify(presentOrder(placed))).not.toMatch(
        /shipment|distance|billable|duration|sellerId|pickup|destination|tariff|landmark/i,
      );
    });

    it('moving an order on leaves its confirmed destination and price alone', async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...placed,
        status: 'PAID',
      });
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        ...placed,
        status: 'PROCESSING',
      });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      await service.updateStatus('ord_1', { status: 'processing' } as never, {
        id: 'adm_1',
        role: 'ADMIN',
      } as never);

      for (const [write] of prisma.order.updateMany.mock.calls) {
        expect(write.data).not.toHaveProperty('deliveryDestination');
        expect(write.data).not.toHaveProperty('deliveryShipments');
        expect(write.data).not.toHaveProperty('deliveryUzs');
      }
    });

    it.each([
      ['PAYME', 'payme'],
      ['CASH', 'cash'],
      [null, null],
    ])(
      'the buyer can tell how it is being paid (%s)',
      (paymentType, payment_type) => {
        expect(
          presentOrder(buildOrder({ paymentType } as never)).payment_type,
        ).toBe(payment_type);
      },
    );
  });

  it('what the order stores is what its Payme receipt adds up to', async () => {
    await service.createFromCart('usr_1', COURIER);
    const { deliveryMethod, deliveryUzs, totalUzs } = created();

    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      deliveryMethod,
      deliveryUzs: new Prisma.Decimal(deliveryUzs),
      totalUzs: new Prisma.Decimal(totalUzs),
      serviceFeeUzs: new Prisma.Decimal(0),
      discountUzs: new Prisma.Decimal(0),
    });
    stubFiscalizableOrderLines(prisma);

    const receipt = await fakeFiscal(prisma, {
      DELIVERY_VAT_PERCENT: '0',
    }).buildOrderDetail('ord_1');

    const line = receipt.items.find(
      (item: { title: string }) => item.title === DELIVERY_TITLE,
    );
    expect(line).toMatchObject({ price: 3_750_000, count: 1 });
    expect(receiptTotalTiyin(receipt.items)).toBe(22_250_000);
  });
});

describe('CreateOrderDto, under the global ValidationPipe', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const parse = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: CreateOrderDto });

  it.each([0, 37_500])('accepts %p', async (confirmed_delivery_uzs) => {
    await expect(parse({ confirmed_delivery_uzs })).resolves.toBeDefined();
  });

  it.each(['37500', -1, 1.5, {}])('refuses %p', async (value) => {
    await expect(
      parse({ confirmed_delivery_uzs: value }),
    ).rejects.toBeDefined();
  });

  it('takes a quote id, within reason', async () => {
    await expect(
      parse({ delivery_quote_id: 'a'.repeat(64) }),
    ).resolves.toBeDefined();
    await expect(
      parse({ delivery_quote_id: 'a'.repeat(129) }),
    ).rejects.toBeDefined();
    await expect(parse({ delivery_quote_id: 7 })).rejects.toBeDefined();
  });

  it.each([
    ['a tariff of its own', { tariff_version: 'cheap' }],
    ['a destination of its own', { destination: { lat: 41, lng: 69 } }],
  ])('refuses a body stating %s', async (_, body) => {
    await expect(parse(body)).rejects.toBeDefined();
  });
});
