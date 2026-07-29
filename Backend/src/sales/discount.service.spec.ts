// Unit tests for the automatic-discount engine. Prisma is mocked — no DB.
// These guard the rules the whole feature rests on: the "no active sale → the
// original price" contract, percentage rounding that keeps
// originalPrice - discountAmount === finalPrice exact, a fixed discount never
// producing a negative price, scope targeting per scopeType (ALL_PRODUCTS /
// PRODUCTS / CATEGORIES / DEALERS), deterministic precedence when several sales
// match one product, no stacking, and the activeness window (including the
// open-ended endAt: null case).

import { Prisma, SaleDiscountType, SaleScopeType } from '@prisma/client';
import { ActiveSale, DiscountService } from './discount.service';

function makePrismaMock() {
  const sale = { findMany: jest.fn() };
  return { sale } as unknown as ConstructorParameters<
    typeof DiscountService
  >[0] & { sale: { findMany: jest.Mock } };
}

/** A sale row as DiscountService consumes it, with sensible defaults. */
function makeSale(overrides: Partial<ActiveSale> = {}): ActiveSale {
  return {
    id: 'sale_1',
    title: 'Test sale',
    description: null,
    discountType: SaleDiscountType.PERCENT,
    discountValue: new Prisma.Decimal(10),
    scopeType: SaleScopeType.ALL_PRODUCTS,
    startAt: new Date('2026-01-01T00:00:00Z'),
    endAt: null,
    isActive: true,
    priority: 0,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    targets: [],
    ...overrides,
  };
}

const PRODUCT = { id: 'part_1', categoryId: 'cat_1', sellerId: 'seller_1' };

describe('DiscountService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: DiscountService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new DiscountService(prisma);
  });

  describe('no active sale', () => {
    it('returns the original price untouched with a null appliedSale', () => {
      const result = service.calculateDiscount(100_000, PRODUCT, []);

      expect(result).toEqual({
        originalPrice: 100_000,
        finalPrice: 100_000,
        discountAmount: 0,
        discountPercent: 0,
        appliedSale: null,
      });
    });

    it('returns the original price when no sale targets the product', () => {
      const sale = makeSale({
        scopeType: SaleScopeType.PRODUCTS,
        targets: [
          { targetType: SaleScopeType.PRODUCTS, targetId: 'part_OTHER' },
        ],
      });

      const result = service.calculateDiscount(100_000, PRODUCT, [sale]);

      expect(result.finalPrice).toBe(100_000);
      expect(result.appliedSale).toBeNull();
    });
  });

  describe('percent discounts', () => {
    it('applies a whole percentage', () => {
      const sale = makeSale({ discountValue: new Prisma.Decimal(15) });

      const result = service.calculateDiscount(200_000, PRODUCT, [sale]);

      expect(result.discountAmount).toBe(30_000);
      expect(result.finalPrice).toBe(170_000);
      expect(result.discountPercent).toBe(15);
      expect(result.appliedSale).toEqual({
        id: 'sale_1',
        title: 'Test sale',
        discountType: SaleDiscountType.PERCENT,
        discountValue: 15,
      });
    });

    it("rounds the discount to the nearest so'm and keeps the arithmetic exact", () => {
      // 12.5% of 99_999 = 12_499.875 -> 12_500
      const sale = makeSale({ discountValue: new Prisma.Decimal(12.5) });

      const result = service.calculateDiscount(99_999, PRODUCT, [sale]);

      expect(result.discountAmount).toBe(12_500);
      expect(result.finalPrice).toBe(87_499);
      // The invariant that keeps a cart total equal to the sum of its lines.
      expect(result.originalPrice - result.discountAmount).toBe(
        result.finalPrice,
      );
    });

    it('a 100% sale makes the item free, never negative', () => {
      const sale = makeSale({ discountValue: new Prisma.Decimal(100) });

      const result = service.calculateDiscount(50_000, PRODUCT, [sale]);

      expect(result.finalPrice).toBe(0);
      expect(result.discountAmount).toBe(50_000);
    });
  });

  describe('fixed discounts', () => {
    it('subtracts an absolute amount', () => {
      const sale = makeSale({
        discountType: SaleDiscountType.FIXED,
        discountValue: new Prisma.Decimal(25_000),
      });

      const result = service.calculateDiscount(100_000, PRODUCT, [sale]);

      expect(result.discountAmount).toBe(25_000);
      expect(result.finalPrice).toBe(75_000);
      expect(result.discountPercent).toBe(25);
    });

    it('never drives the price below zero when it exceeds the price', () => {
      const sale = makeSale({
        discountType: SaleDiscountType.FIXED,
        discountValue: new Prisma.Decimal(500_000),
      });

      const result = service.calculateDiscount(100_000, PRODUCT, [sale]);

      expect(result.finalPrice).toBe(0);
      expect(result.discountAmount).toBe(100_000);
      expect(result.finalPrice).toBeGreaterThanOrEqual(0);
    });
  });

  describe('scope targeting', () => {
    it('ALL_PRODUCTS applies to any product, reading no targets', () => {
      const sale = makeSale({ scopeType: SaleScopeType.ALL_PRODUCTS });

      expect(service.appliesTo(sale, PRODUCT)).toBe(true);
      expect(
        service.appliesTo(sale, { id: 'anything', categoryId: null }),
      ).toBe(true);
    });

    it('PRODUCTS matches on the product id', () => {
      const sale = makeSale({
        scopeType: SaleScopeType.PRODUCTS,
        targets: [{ targetType: SaleScopeType.PRODUCTS, targetId: 'part_1' }],
      });

      expect(service.appliesTo(sale, PRODUCT)).toBe(true);
      expect(service.appliesTo(sale, { ...PRODUCT, id: 'part_2' })).toBe(false);
    });

    it('CATEGORIES matches on the category id', () => {
      const sale = makeSale({
        scopeType: SaleScopeType.CATEGORIES,
        targets: [{ targetType: SaleScopeType.CATEGORIES, targetId: 'cat_1' }],
      });

      expect(service.appliesTo(sale, PRODUCT)).toBe(true);
      expect(service.appliesTo(sale, { ...PRODUCT, categoryId: 'cat_2' })).toBe(
        false,
      );
    });

    it('DEALERS matches on the seller id', () => {
      const sale = makeSale({
        scopeType: SaleScopeType.DEALERS,
        targets: [{ targetType: SaleScopeType.DEALERS, targetId: 'seller_1' }],
      });

      expect(service.appliesTo(sale, PRODUCT)).toBe(true);
      expect(
        service.appliesTo(sale, { ...PRODUCT, sellerId: 'seller_2' }),
      ).toBe(false);
    });

    it('does not match when the product lacks the field the scope reads', () => {
      const sale = makeSale({
        scopeType: SaleScopeType.CATEGORIES,
        targets: [{ targetType: SaleScopeType.CATEGORIES, targetId: 'cat_1' }],
      });

      // A caller that passed only an id — no category to compare against.
      expect(service.appliesTo(sale, { id: 'part_1' })).toBe(false);
    });

    it('fails closed on a scope with no matcher rather than discounting everything', () => {
      const sale = makeSale({
        scopeType: 'BRANDS' as SaleScopeType, // a future enum value, no matcher yet
        targets: [{ targetType: 'BRANDS' as SaleScopeType, targetId: 'b_1' }],
      });

      expect(service.appliesTo(sale, PRODUCT)).toBe(false);
    });
  });

  describe('precedence when several sales match', () => {
    it('the higher priority wins even if it is newer AND discounts less', () => {
      // Priority is key 1, so it beats both remaining keys at once: `shallow`
      // discounts 10x less and was created later, and still wins.
      const shallow = makeSale({
        id: 'sale_shallow',
        discountValue: new Prisma.Decimal(5),
        priority: 10,
        createdAt: new Date('2026-03-01T00:00:00Z'),
      });
      const deep = makeSale({
        id: 'sale_deep',
        discountValue: new Prisma.Decimal(50),
        priority: 1,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });

      const result = service.calculateDiscount(100_000, PRODUCT, [
        deep,
        shallow,
      ]);

      expect(result.appliedSale?.id).toBe('sale_shallow');
      expect(result.finalPrice).toBe(95_000);
    });

    it('at equal priority the OLDER sale wins, even if it discounts far less', () => {
      // Discount size is deliberately not a tie-break: only priority is.
      const older = makeSale({
        id: 'sale_older',
        discountValue: new Prisma.Decimal(10),
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const newerButDeeper = makeSale({
        id: 'sale_newer',
        discountValue: new Prisma.Decimal(30),
        createdAt: new Date('2026-02-01T00:00:00Z'),
      });

      const result = service.calculateDiscount(100_000, PRODUCT, [
        older,
        newerButDeeper,
      ]);

      expect(result.appliedSale?.id).toBe('sale_older');
      expect(result.finalPrice).toBe(90_000);
    });

    it('falls back to the lowest id when priority AND createdAt tie', () => {
      const sameInstant = new Date('2026-01-01T00:00:00Z');
      const a = makeSale({
        id: 'sale_a',
        discountValue: new Prisma.Decimal(30),
        createdAt: sameInstant,
      });
      const b = makeSale({
        id: 'sale_b',
        discountValue: new Prisma.Decimal(10),
        createdAt: sameInstant,
      });

      const result = service.calculateDiscount(100_000, PRODUCT, [b, a]);

      expect(result.appliedSale?.id).toBe('sale_a');
    });

    it('is deterministic regardless of the order sales arrive in', () => {
      const sameInstant = new Date('2026-01-01T00:00:00Z');
      const a = makeSale({
        id: 'sale_a',
        discountValue: new Prisma.Decimal(20),
        createdAt: sameInstant,
      });
      const b = makeSale({
        id: 'sale_b',
        discountValue: new Prisma.Decimal(20),
        createdAt: sameInstant,
      });

      const forward = service.calculateDiscount(100_000, PRODUCT, [a, b]);
      const reverse = service.calculateDiscount(100_000, PRODUCT, [b, a]);

      expect(forward.appliedSale?.id).toBe(reverse.appliedSale?.id);
      expect(forward.finalPrice).toBe(reverse.finalPrice);
    });

    /**
     * The property that motivates dropping discount size as a tie-break: a
     * PERCENT and a FIXED sale rank differently at different prices, so ranking
     * by size would let the winner change from product to product inside one
     * cart. Selection must not depend on the price at all.
     */
    it('picks the SAME sale for every product, whatever the price', () => {
      const percentSale = makeSale({
        id: 'sale_percent',
        discountType: SaleDiscountType.PERCENT,
        discountValue: new Prisma.Decimal(20),
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const fixedSale = makeSale({
        id: 'sale_fixed',
        discountType: SaleDiscountType.FIXED,
        discountValue: new Prisma.Decimal(50_000),
        createdAt: new Date('2026-02-01T00:00:00Z'),
      });
      const sales = [percentSale, fixedSale];

      // At 100 000 the fixed sale would be "deeper" (50 000 > 20 000); at
      // 1 000 000 the percent sale would (200 000 > 50 000). The winner must
      // not flip between the two.
      const cheap = service.calculateDiscount(100_000, PRODUCT, sales);
      const pricey = service.calculateDiscount(1_000_000, PRODUCT, sales);

      expect(cheap.appliedSale?.id).toBe('sale_percent');
      expect(pricey.appliedSale?.id).toBe('sale_percent');
      // Same campaign, applied consistently at each price.
      expect(cheap.finalPrice).toBe(80_000);
      expect(pricey.finalPrice).toBe(800_000);
    });

    /**
     * Three overlapping campaigns of different scopes, all matching one GM part
     * sold by dealer #15 — the realistic worst case for "which one wins?".
     */
    describe('Summer 10% (all) + GM Parts 20% (category) + Dealer #15 5% (dealer)', () => {
      // Set up in this order: Summer first, then GM Parts, then Dealer #15.
      const summer = makeSale({
        id: 'sale_summer',
        title: 'Summer Sale',
        discountValue: new Prisma.Decimal(10),
        createdAt: new Date('2026-06-01T00:00:00Z'),
      });
      const gmParts = makeSale({
        id: 'sale_gm',
        title: 'GM Parts',
        discountValue: new Prisma.Decimal(20),
        scopeType: SaleScopeType.CATEGORIES,
        targets: [{ targetType: SaleScopeType.CATEGORIES, targetId: 'cat_1' }],
        createdAt: new Date('2026-06-15T00:00:00Z'),
      });
      const dealer15 = makeSale({
        id: 'sale_dealer',
        title: 'Dealer #15',
        discountValue: new Prisma.Decimal(5),
        scopeType: SaleScopeType.DEALERS,
        targets: [{ targetType: SaleScopeType.DEALERS, targetId: 'seller_1' }],
        createdAt: new Date('2026-07-01T00:00:00Z'),
      });

      it('at equal priority the OLDEST (Summer, 10%) wins — applied once, not 10+20+5', () => {
        const result = service.calculateDiscount(100_000, PRODUCT, [
          summer,
          gmParts,
          dealer15,
        ]);

        expect(result.appliedSale?.title).toBe('Summer Sale');
        expect(result.discountAmount).toBe(10_000);
        expect(result.finalPrice).toBe(90_000);
      });

      it('priority is the lever: Dealer #15 at priority 10 wins with only 5%', () => {
        const result = service.calculateDiscount(100_000, PRODUCT, [
          summer,
          gmParts,
          { ...dealer15, priority: 10 },
        ]);

        expect(result.appliedSale?.title).toBe('Dealer #15');
        expect(result.finalPrice).toBe(95_000);
      });

      it('to make GM Parts win, raise ITS priority — nothing else does', () => {
        const result = service.calculateDiscount(100_000, PRODUCT, [
          summer,
          { ...gmParts, priority: 5 },
          dealer15,
        ]);

        expect(result.appliedSale?.title).toBe('GM Parts');
        expect(result.finalPrice).toBe(80_000);
      });
    });

    it('never stacks: two 20% sales give 20% off, not 36% or 40%', () => {
      const a = makeSale({
        id: 'sale_a',
        discountValue: new Prisma.Decimal(20),
      });
      const b = makeSale({
        id: 'sale_b',
        discountValue: new Prisma.Decimal(20),
      });

      const result = service.calculateDiscount(100_000, PRODUCT, [a, b]);

      expect(result.discountAmount).toBe(20_000);
      expect(result.finalPrice).toBe(80_000);
    });

    it('ignores non-matching sales when picking the winner', () => {
      const deepButElsewhere = makeSale({
        id: 'sale_elsewhere',
        discountValue: new Prisma.Decimal(90),
        scopeType: SaleScopeType.PRODUCTS,
        targets: [
          { targetType: SaleScopeType.PRODUCTS, targetId: 'part_OTHER' },
        ],
      });
      const applicable = makeSale({
        id: 'sale_applicable',
        discountValue: new Prisma.Decimal(10),
      });

      const result = service.calculateDiscount(100_000, PRODUCT, [
        deepButElsewhere,
        applicable,
      ]);

      expect(result.appliedSale?.id).toBe('sale_applicable');
      expect(result.finalPrice).toBe(90_000);
    });
  });

  describe('edge cases', () => {
    it.each([0, -100, Number.NaN, Number.POSITIVE_INFINITY])(
      'returns %p unchanged rather than inventing a discount',
      (price) => {
        const sale = makeSale({ discountValue: new Prisma.Decimal(50) });

        const result = service.calculateDiscount(price, PRODUCT, [sale]);

        expect(result.finalPrice).toBe(price);
        expect(result.appliedSale).toBeNull();
      },
    );

    it('treats a rounded-to-zero discount as no discount at all', () => {
      // 0.01% of 100 so'm rounds to 0 — reporting an "applied" sale that
      // changed nothing would be misleading.
      const sale = makeSale({ discountValue: new Prisma.Decimal(0.01) });

      const result = service.calculateDiscount(100, PRODUCT, [sale]);

      expect(result.discountAmount).toBe(0);
      expect(result.appliedSale).toBeNull();
    });
  });

  describe('activeWhere', () => {
    it('requires not-deleted, isActive, a started window, and an unexpired or open end', () => {
      const now = new Date('2026-07-29T12:00:00Z');

      expect(service.activeWhere(now)).toEqual({
        deletedAt: null,
        isActive: true,
        startAt: { lte: now },
        OR: [{ endAt: null }, { endAt: { gte: now } }],
      });
    });

    it('excludes an expired sale purely by the clock — no sweeper job needed', async () => {
      // A sale with isActive=true whose endAt has passed is filtered out by the
      // query itself, so nothing ever has to write to the row to retire it.
      prisma.sale.findMany.mockResolvedValue([]);
      const now = new Date('2026-09-01T00:00:00Z');

      const sales = await service.loadActiveSales(now);

      expect(sales).toEqual([]);
      // endAt must be null OR still in the future — an August endAt matches neither.
      expect(service.activeWhere(now).OR).toEqual([
        { endAt: null },
        { endAt: { gte: now } },
      ]);
    });

    it('excludes soft-deleted sales from pricing', () => {
      expect(service.activeWhere().deletedAt).toBeNull();
    });
  });

  describe('loadActiveSales / calculateDiscounts', () => {
    it('queries with the activeness predicate and includes targets', async () => {
      prisma.sale.findMany.mockResolvedValue([]);
      const now = new Date('2026-07-29T12:00:00Z');

      await service.loadActiveSales(now);

      expect(prisma.sale.findMany).toHaveBeenCalledWith({
        where: service.activeWhere(now),
        include: { targets: { select: { targetType: true, targetId: true } } },
      });
    });

    it('prices many products from a single query', async () => {
      prisma.sale.findMany.mockResolvedValue([
        makeSale({ discountValue: new Prisma.Decimal(10) }),
      ]);

      const results = await service.calculateDiscounts([
        { product: { id: 'part_1' }, price: 100_000 },
        { product: { id: 'part_2' }, price: 50_000 },
      ]);

      expect(prisma.sale.findMany).toHaveBeenCalledTimes(1);
      expect(results.get('part_1')?.finalPrice).toBe(90_000);
      expect(results.get('part_2')?.finalPrice).toBe(45_000);
    });

    it('does not query at all for an empty batch', async () => {
      const results = await service.calculateDiscounts([]);

      expect(prisma.sale.findMany).not.toHaveBeenCalled();
      expect(results.size).toBe(0);
    });
  });
});
