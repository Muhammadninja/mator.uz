/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// The service fee on an order: worked out from the server's own cart when the order is
// placed, stored apart from goods and delivery, and never taken from the request.

import { ValidationPipe } from '@nestjs/common';
import { CartService } from '../cart/cart.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { presentOrder } from './order.presenter';
import { settleOrder } from './order-settlement';
import { OrderStatusService } from './order-status.service';
import { OrdersService } from './orders.service';
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
} from '../../test/utils/harness';

const DESTINATION = {
  addressId: 'addr_1',
  lat: 41.3131,
  lng: 69.287,
  label: 'Work',
  fullText: 'Amir Temur 12, Toshkent',
  regionCode: null,
  district: 'Yunusobod',
  street: 'Amir Temur 12',
  landmark: null,
};
const QUOTE = {
  priceUzs: 25_000,
  quoteId: 'quote_1',
  destination: DESTINATION,
  shipments: [],
};
const COURIER = {
  cart_snapshot: { delivery_method: 'courier', delivery_address_id: 'addr_1' },
  confirmed_delivery_uzs: 25_000,
  delivery_quote_id: 'quote_1',
};
const PICKUP = { cart_snapshot: { delivery_method: 'pickup' } };

/** A catalog part, as the availability gate, the sale pricing and the seller lookup read it. */
const catalogPart = (id: string, sellerId: string) => ({
  id,
  inStock: true,
  priceUzs: 100_000,
  seller: { status: 'ACTIVE' },
  categoryId: 'cat_1',
  sellerId,
});

describe('The service fee on an order', () => {
  let prisma: PrismaMock;
  let service: OrdersService;
  let quotes: { quote: jest.Mock };

  const created = () => prisma.order.create.mock.calls[0][0].data;
  const cartOf = (items: any[]) =>
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({ id: 'cart_1', userId: 'usr_1', items }),
    );

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
    prisma.catalogPart.findMany.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) =>
            catalogPart(id, id === 'part_b' ? 'dealer_b' : 'dealer_a'),
          ),
        ),
    );
    prisma.seller.findMany.mockResolvedValue([
      { id: 7, tgId: BigInt(555), catalogSellerId: null },
    ]);
    prisma.order.create.mockResolvedValue(buildOrder({ id: 'ord_1' }));
  });

  it('the brief’s example: 600 000 of parts, 20 000 fee, 25 000 delivery, 645 000 in all', async () => {
    cartOf([
      buildCartItem({
        id: 'ci_1',
        partId: 'part_a',
        priceUzsSnapshot: 600_000,
      }),
    ]);

    await service.createFromCart('usr_1', COURIER);

    expect(created()).toMatchObject({
      subtotalUzs: 600_000,
      serviceFeeUzs: 20_000,
      deliveryUzs: 25_000,
      discountUzs: 0,
      totalUzs: 645_000,
    });
  });

  it('several items in one cart: one fee for the order, and no line carries any of it', async () => {
    cartOf([
      buildCartItem({
        id: 'ci_1',
        partId: 'part_a',
        priceUzsSnapshot: 150_000,
      }),
      buildCartItem({
        id: 'ci_2',
        partId: 'part_a2',
        priceUzsSnapshot: 100_000,
        quantity: 2,
      }),
      buildCartItem({
        id: 'ci_3',
        partId: 'part_a3',
        priceUzsSnapshot: 50_000,
        quantity: 3,
      }),
    ]);

    await service.createFromCart('usr_1', PICKUP);

    const data = created();
    expect(data.subtotalUzs).toBe(500_000);
    expect(data.serviceFeeUzs).toBe(20_000);
    expect(data.totalUzs).toBe(520_000);
    const lines = data.items.create;
    expect(lines.map((l: any) => l.lineTotalUzs)).toEqual([
      150_000, 200_000, 150_000,
    ]);
    expect(lines.reduce((s: number, l: any) => s + l.lineTotalUzs, 0)).toBe(
      data.subtotalUzs,
    );
  });

  it('several sellers in one order: still one fee, and each line remembers its own seller', async () => {
    cartOf([
      buildCartItem({
        id: 'ci_1',
        partId: 'part_a',
        priceUzsSnapshot: 300_000,
      }),
      buildCartItem({
        id: 'ci_2',
        partId: 'part_b',
        priceUzsSnapshot: 250_000,
      }),
      buildCartItem({
        id: 'ci_3',
        partId: null,
        offerId: 'soff_1',
        offer: { sellerTgId: '555' },
        priceUzsSnapshot: 100_000,
      }),
    ]);

    await service.createFromCart('usr_1', COURIER);

    const data = created();
    expect(data.serviceFeeUzs).toBe(20_000); // 650 000 of parts
    expect(data.items.create.map((l: any) => l.sellerId)).toEqual([
      'dealer_a',
      'dealer_b',
      'seller_7', // the storefront an offer's seller projects into
    ]);

    // What each seller is owed comes from their own lines: the fee and delivery are not
    // anybody's but Mator's, and everything adds up to what the buyer pays.
    const settlement = settleOrder({ ...data, items: data.items.create });
    // No commission is configured for any of them in this test, which charges 0%.
    expect(settlement.sellers).toEqual([
      {
        sellerId: 'dealer_a',
        amountUzs: 300_000,
        commissionUzs: 0,
        netUzs: 300_000,
      },
      {
        sellerId: 'dealer_b',
        amountUzs: 250_000,
        commissionUzs: 0,
        netUzs: 250_000,
      },
      {
        sellerId: 'seller_7',
        amountUzs: 100_000,
        commissionUzs: 0,
        netUzs: 100_000,
      },
    ]);
    expect(settlement.serviceFeeUzs).toBe(20_000);
    expect(
      settlement.sellers.reduce((s, x) => s + x.amountUzs, 0) +
        settlement.serviceFeeUzs +
        settlement.deliveryUzs,
    ).toBe(data.totalUzs);
  });

  it('with delivery: the fee is not in the delivery price, nor delivery in the fee', async () => {
    cartOf([
      buildCartItem({
        id: 'ci_1',
        partId: 'part_a',
        priceUzsSnapshot: 150_000,
      }),
    ]);

    await service.createFromCart('usr_1', COURIER);

    expect(created()).toMatchObject({
      deliveryUzs: 25_000,
      serviceFeeUzs: 5_000,
      totalUzs: 180_000,
    });
  });

  it('without delivery: the parts and the fee', async () => {
    cartOf([
      buildCartItem({
        id: 'ci_1',
        partId: 'part_a',
        priceUzsSnapshot: 150_000,
      }),
    ]);

    await service.createFromCart('usr_1', PICKUP);

    expect(quotes.quote).not.toHaveBeenCalled();
    expect(created()).toMatchObject({
      deliveryUzs: 0,
      serviceFeeUzs: 5_000,
      totalUzs: 155_000,
    });
  });

  it('a cart up to 100 000 has no fee, and no line for one', async () => {
    cartOf([
      buildCartItem({
        id: 'ci_1',
        partId: 'part_a',
        priceUzsSnapshot: 100_000,
      }),
    ]);

    await service.createFromCart('usr_1', PICKUP);

    expect(created()).toMatchObject({ serviceFeeUzs: 0, totalUzs: 100_000 });
    expect(created().items.create).toHaveLength(1);
  });

  describe('a figure from the client is never charged', () => {
    beforeEach(() => {
      cartOf([
        buildCartItem({
          id: 'ci_1',
          partId: 'part_a',
          priceUzsSnapshot: 600_000,
        }),
      ]);
    });

    it('a fee or a total stated beside the order’s choices is ignored', async () => {
      await service.createFromCart('usr_1', {
        cart_snapshot: {
          delivery_method: 'pickup',
          service_fee_uzs: 0,
          serviceFeeUzs: 0,
          total_uzs: 1,
          totalUzs: 1,
        } as never,
      });

      expect(created()).toMatchObject({
        serviceFeeUzs: 20_000,
        totalUzs: 620_000,
      });
    });

    it('a total the buyer was not shown is refused: nothing is created and the cart stays', async () => {
      await expect(
        service.createFromCart('usr_1', {
          ...PICKUP,
          confirmed_total_uzs: 600_000,
        }),
      ).rejects.toMatchObject({ response: { code: 'ORDER_TOTAL_CHANGED' } });
      await expect(
        service.createFromCart('usr_1', { ...PICKUP, confirmed_total_uzs: 1 }),
      ).rejects.toMatchObject({ response: { code: 'ORDER_TOTAL_CHANGED' } });

      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.cartItem.deleteMany).not.toHaveBeenCalled();
    });

    it('the total the buyer was shown, to the tiyin, places the order at the server’s figures', async () => {
      await service.createFromCart('usr_1', {
        ...PICKUP,
        confirmed_total_uzs: 620_000,
      });

      expect(created()).toMatchObject({
        serviceFeeUzs: 20_000,
        totalUzs: 620_000,
      });
    });

    it('a client stating no total is charged what the server computes', async () => {
      await service.createFromCart('usr_1', PICKUP);

      expect(created().totalUzs).toBe(620_000);
    });
  });

  it('a changed cart changes the fee before the order, and the order takes the new one', async () => {
    // The buyer was shown one unit: 99 000 and no fee. Meanwhile a second unit went in,
    // from another device, so that total no longer holds.
    cartOf([
      buildCartItem({
        id: 'ci_1',
        partId: 'part_a',
        priceUzsSnapshot: 99_000,
        quantity: 2,
      }),
    ]);
    await expect(
      service.createFromCart('usr_1', {
        ...PICKUP,
        confirmed_total_uzs: 99_000,
      }),
    ).rejects.toMatchObject({ response: { code: 'ORDER_TOTAL_CHANGED' } });

    // The total the cart shows now: 198 000 and the 5 000 fee.
    await service.createFromCart('usr_1', {
      ...PICKUP,
      confirmed_total_uzs: 203_000,
    });
    expect(created()).toMatchObject({
      serviceFeeUzs: 5_000,
      totalUzs: 203_000,
    });
  });

  it('the order shows each part of what it charges, as stored', () => {
    const view = presentOrder(
      buildOrder({
        subtotalUzs: 600_000,
        discountUzs: 0,
        serviceFeeUzs: 20_000,
        deliveryUzs: 25_000,
        totalUzs: 645_000,
      }),
    );
    expect(view).toMatchObject({
      subtotal_uzs: 600_000,
      service_fee_uzs: 20_000,
      delivery_uzs: 25_000,
      discount_uzs: 0,
      total_uzs: 645_000,
    });
  });
});

describe('The cart: the fee is worked out again on every change', () => {
  it('reads, adds and changes all answer with the fee for the cart as it now is', async () => {
    const prisma = createPrismaMock();
    const cart = new CartService(prisma, fakeDiscounts());
    const withQuantity = (quantity: number) =>
      buildCart({
        id: 'cart_1',
        userId: 'usr_1',
        items: [
          buildCartItem({
            id: 'ci_1',
            partId: 'part_a',
            priceUzsSnapshot: 99_000,
            quantity,
          }),
        ],
      });
    prisma.cart.upsert.mockResolvedValue(withQuantity(1));
    expect(await cart.snapshot('usr_1')).toMatchObject({
      subtotal_uzs: 99_000,
      service_fee_uzs: 0,
      total_uzs: 99_000,
    });

    prisma.cartItem.findUnique.mockResolvedValue({
      id: 'ci_1',
      cart: { userId: 'usr_1' },
    });
    prisma.cart.upsert.mockResolvedValue(withQuantity(3));
    expect(await cart.updateItem('usr_1', 'ci_1', 3)).toMatchObject({
      subtotal_uzs: 297_000,
      service_fee_uzs: 10_000,
      total_uzs: 307_000,
    });

    prisma.cart.upsert.mockResolvedValue(withQuantity(2));
    expect(await cart.removeItem('usr_1', 'ci_1')).toMatchObject({
      service_fee_uzs: 5_000,
    });
  });
});

describe('CreateOrderDto: no amount from the client reaches an order', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const parse = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: CreateOrderDto });

  it.each([
    ['a service fee', { service_fee_uzs: 0 }],
    ['a total', { total_uzs: 1 }],
    ['a subtotal', { subtotal_uzs: 1 }],
    ['a delivery price', { delivery_uzs: 0 }],
  ])('refuses a body stating %s: there is no such field', async (_, body) => {
    await expect(parse(body)).rejects.toBeDefined();
  });

  it.each([0, 645_000, 64_516.71])(
    'takes the total the buyer was shown (%p)',
    async (confirmed_total_uzs) => {
      await expect(parse({ confirmed_total_uzs })).resolves.toBeDefined();
    },
  );

  it.each(['645000', -1, {}])(
    'refuses a shown total that is no amount (%p)',
    async (confirmed_total_uzs) => {
      await expect(parse({ confirmed_total_uzs })).rejects.toBeDefined();
    },
  );

  it('takes a body stating no total: the service then charges what it computes', async () => {
    await expect(parse({})).resolves.toBeDefined();
  });
});
