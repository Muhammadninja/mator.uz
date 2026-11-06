/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// Mator's commission on a seller's goods: each seller's own rate, frozen on the order's lines
// when it is placed. No rate configured charges 0%. Delivery and the service fee are never in
// it. Not to be confused with Payme's commission_info.tin, which names the seller on a receipt.

import { Prisma } from '@prisma/client';
import { lineCommissionUzs, settleOrder } from './order-settlement';
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

const COURIER = {
  cart_snapshot: { delivery_method: 'courier', delivery_address_id: 'addr_1' },
  confirmed_delivery_uzs: 25_000,
  delivery_quote_id: 'quote_1',
};
const PICKUP = { cart_snapshot: { delivery_method: 'pickup' } };

describe("Mator's commission on an order", () => {
  let prisma: PrismaMock;
  let service: OrdersService;
  /** Each storefront's configured rate. Absent from the map: none configured. */
  let rates: Map<string, Prisma.Decimal | null>;

  const created = () => prisma.order.create.mock.calls.at(-1)[0].data;
  const lines = () => created().items.create;

  beforeEach(() => {
    prisma = createPrismaMock();
    rates = new Map();
    service = new OrdersService(
      prisma,
      fakeConfig(),
      fakeNotifications(),
      fakeRealtime(),
      new OrderStatusService(prisma),
      fakeDiscounts(),
      { record: jest.fn() } as never,
      {
        quote: jest.fn().mockResolvedValue({
          priceUzs: 25_000,
          quoteId: 'quote_1',
          destination: null,
          shipments: [],
        }),
      } as never,
    );
    prisma.address.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'usr_1',
    });
    prisma.catalogPart.findMany.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) => ({
            id,
            inStock: true,
            priceUzs: 100_000,
            seller: { status: 'ACTIVE' },
            categoryId: 'cat_1',
            sellerId: id === 'part_b' ? 'dealer_b' : 'dealer_a',
          })),
        ),
    );
    prisma.catalogSeller.findMany.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in
            .filter((id) => rates.has(id))
            .map((id) => ({ id, commissionPercent: rates.get(id) })),
        ),
    );
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({
        id: 'cart_1',
        userId: 'usr_1',
        items: [
          buildCartItem({
            id: 'ci_1',
            partId: 'part_a',
            priceUzsSnapshot: 400_000,
          }),
          buildCartItem({
            id: 'ci_2',
            partId: 'part_b',
            priceUzsSnapshot: 200_000,
          }),
        ],
      }),
    );
    prisma.order.create.mockResolvedValue(buildOrder({ id: 'ord_1' }));
  });

  it('no rate configured charges 0%, and says so on the line', async () => {
    await service.createFromCart('usr_1', PICKUP);

    expect(
      lines().map((l: any) => [
        l.sellerId,
        Number(l.commissionPercent),
        Number(l.commissionUzs),
      ]),
    ).toEqual([
      ['dealer_a', 0, 0],
      ['dealer_b', 0, 0],
    ]);
  });

  it('an explicit 0% is charged as 0%', async () => {
    rates.set('dealer_a', new Prisma.Decimal(0));
    rates.set('dealer_b', new Prisma.Decimal(0));

    await service.createFromCart('usr_1', PICKUP);

    expect(lines().every((l: any) => Number(l.commissionUzs) === 0)).toBe(true);
  });

  it('each seller’s own rate, on their own goods only: never delivery or the fee', async () => {
    rates.set('dealer_a', new Prisma.Decimal(7.5));

    await service.createFromCart('usr_1', COURIER);

    expect(
      lines().map((l: any) => [
        l.sellerId,
        Number(l.commissionPercent),
        Number(l.commissionUzs),
      ]),
    ).toEqual([
      ['dealer_a', 7.5, 30_000],
      ['dealer_b', 0, 0],
    ]);
    // 600 000 of parts, 20 000 fee, 25 000 delivery: none of the fee or delivery is commission.
    const data = created();
    expect(data).toMatchObject({
      serviceFeeUzs: 20_000,
      deliveryUzs: 25_000,
      totalUzs: 645_000,
    });
    const settlement = settleOrder({ ...data, items: lines() });
    expect(settlement.commissionUzs).toBe(30_000);
    expect(settlement.sellers).toEqual([
      {
        sellerId: 'dealer_a',
        amountUzs: 400_000,
        commissionUzs: 30_000,
        netUzs: 370_000,
      },
      {
        sellerId: 'dealer_b',
        amountUzs: 200_000,
        commissionUzs: 0,
        netUzs: 200_000,
      },
    ]);
    // Everything adds up to what the buyer paid.
    expect(
      settlement.sellers.reduce((s, x) => s + x.netUzs, 0) +
        settlement.commissionUzs +
        settlement.serviceFeeUzs +
        settlement.deliveryUzs,
    ).toBe(645_000);
  });

  it('a promo spread into the line prices is in the base, as the line is charged', async () => {
    rates.set('dealer_a', new Prisma.Decimal(10));
    prisma.cart.findUnique.mockResolvedValue(
      buildCart({
        id: 'cart_1',
        userId: 'usr_1',
        promoCode: 'MATOR10',
        items: [
          buildCartItem({
            id: 'ci_1',
            partId: 'part_a',
            priceUzsSnapshot: 200_000,
          }),
        ],
      }),
    );

    await service.createFromCart('usr_1', PICKUP);

    // 200 000 less the 10% promo is a line of 180 000; 10% of it.
    expect(Number(lines()[0].lineTotalUzs)).toBe(180_000);
    expect(Number(lines()[0].commissionUzs)).toBe(18_000);
  });

  it('a new rate reaches only orders placed after it', async () => {
    rates.set('dealer_a', new Prisma.Decimal(5));
    await service.createFromCart('usr_1', PICKUP);
    const first = lines();

    rates.set('dealer_a', new Prisma.Decimal(12));
    await service.createFromCart('usr_1', PICKUP);
    const second = lines();

    expect(Number(first[0].commissionPercent)).toBe(5);
    expect(Number(first[0].commissionUzs)).toBe(20_000);
    expect(Number(second[0].commissionPercent)).toBe(12);
    expect(Number(second[0].commissionUzs)).toBe(48_000);
  });
});

describe('lineCommissionUzs', () => {
  it.each([
    [400_000, 7.5, 30_000],
    [180_000, 10, 18_000],
    [64_516.71, 3, 1_935.5],
    [100_000, 0, 0],
    [33_333.33, 2.5, 833.33],
  ])('%p at %p%% → %p', (line, percent, commission) => {
    expect(Number(lineCommissionUzs(line, percent))).toBe(commission);
  });
});
