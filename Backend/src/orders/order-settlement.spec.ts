// Whose money an order holds: what each seller is owed, and what is Mator's.

import { Prisma } from '@prisma/client';
import { findLineSellers, settleOrder } from './order-settlement';

describe('settleOrder', () => {
  const order = (over: Partial<Parameters<typeof settleOrder>[0]> = {}) => ({
    serviceFeeUzs: 20_000,
    deliveryUzs: 25_000,
    totalUzs: 645_000,
    items: [
      { sellerId: 'dealer_a', lineTotalUzs: 350_000 },
      { sellerId: 'dealer_b', lineTotalUzs: 200_000 },
      { sellerId: 'dealer_a', lineTotalUzs: 50_000 },
    ],
    ...over,
  });

  it('pays each seller the sum of their own lines, and never the fee or delivery', () => {
    const settlement = settleOrder(order());

    expect(settlement.sellers).toEqual([
      { sellerId: 'dealer_a', amountUzs: 400_000 },
      { sellerId: 'dealer_b', amountUzs: 200_000 },
    ]);
    expect(settlement.serviceFeeUzs).toBe(20_000);
    expect(settlement.deliveryUzs).toBe(25_000);
  });

  it('adds up to what the buyer paid, to the tiyin', () => {
    const s = settleOrder(order());
    const sellers = s.sellers.reduce((sum, x) => sum + x.amountUzs, 0);
    expect(sellers + s.serviceFeeUzs + s.deliveryUzs).toBe(s.totalUzs);
  });

  it('reads Decimal columns as stored, fractions included', () => {
    const s = settleOrder({
      serviceFeeUzs: new Prisma.Decimal(5_000),
      deliveryUzs: new Prisma.Decimal(0),
      totalUzs: new Prisma.Decimal('69516.71'),
      items: [
        { sellerId: 'dealer_a', lineTotalUzs: new Prisma.Decimal('64516.71') },
      ],
    });
    expect(s.sellers).toEqual([{ sellerId: 'dealer_a', amountUzs: 64_516.71 }]);
    expect(s.totalUzs).toBe(69_516.71);
  });

  it('a service line is owed to its provider, and a line with nobody to name stays apart', () => {
    const s = settleOrder(
      order({
        serviceFeeUzs: 0,
        deliveryUzs: 0,
        totalUzs: 330_000,
        items: [
          { providerId: 'prov_1', lineTotalUzs: 100_000 },
          { sellerId: null, providerId: null, lineTotalUzs: 230_000 },
        ],
      }),
    );
    expect(s.providers).toEqual([{ providerId: 'prov_1', amountUzs: 100_000 }]);
    expect(s.sellers).toEqual([]);
    expect(s.unattributedUzs).toBe(230_000);
  });

  it('a promo already inside the line prices is the line’s, as charged', () => {
    const s = settleOrder(
      order({
        serviceFeeUzs: 10_000,
        deliveryUzs: 0,
        totalUzs: 190_000,
        items: [{ sellerId: 'dealer_a', lineTotalUzs: 180_000 }],
      }),
    );
    expect(s.sellers).toEqual([{ sellerId: 'dealer_a', amountUzs: 180_000 }]);
  });
});

describe('findLineSellers', () => {
  const prismaWith = (
    parts: { id: string; sellerId: string }[],
    sellers: { id: number; tgId: bigint; catalogSellerId: string | null }[],
  ) => ({
    catalogPart: { findMany: jest.fn().mockResolvedValue(parts) },
    seller: { findMany: jest.fn().mockResolvedValue(sellers) },
  });

  it('names the storefront of each part and of each offer’s seller', async () => {
    const prisma = prismaWith(
      [
        { id: 'part_a', sellerId: 'dealer_a' },
        { id: 'part_b', sellerId: 'dealer_b' },
      ],
      [
        { id: 7, tgId: BigInt(555), catalogSellerId: null },
        { id: 8, tgId: BigInt(777), catalogSellerId: 'dealer_b' },
      ],
    );

    const sellers = await findLineSellers(prisma as never, [
      { id: 'ci_1', partId: 'part_a' },
      { id: 'ci_2', partId: 'part_b' },
      { id: 'ci_3', partId: null, offer: { sellerTgId: '555' } },
      { id: 'ci_4', partId: null, offer: { sellerTgId: '777' } },
    ]);

    expect([...sellers]).toEqual([
      ['ci_1', 'dealer_a'],
      ['ci_2', 'dealer_b'],
      ['ci_3', 'seller_7'],
      // An operator's link wins over the projected id.
      ['ci_4', 'dealer_b'],
    ]);
  });

  it('guesses nothing: a part that is gone, an unknown seller or a service gets no seller', async () => {
    const prisma = prismaWith([], []);

    const sellers = await findLineSellers(prisma as never, [
      { id: 'ci_1', partId: 'part_gone' },
      { id: 'ci_2', partId: null, offer: { sellerTgId: '999' } },
      { id: 'ci_3', partId: null, offer: null },
    ]);

    expect(sellers.size).toBe(0);
  });

  it('reads nothing when there is nothing to look up', async () => {
    const prisma = prismaWith([], []);

    await findLineSellers(prisma as never, [
      { id: 'ci_1', partId: null, offer: { sellerTgId: 'not-a-number' } },
    ]);

    expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
    expect(prisma.seller.findMany).not.toHaveBeenCalled();
  });
});
