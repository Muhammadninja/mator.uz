// LOW-CAT-007: sorting and price ranges follow the price the card shows.

import { Prisma, SaleDiscountType, SaleScopeType } from '@prisma/client';
import { DiscountService } from '../../sales/discount.service';
import { MAX_PRICED_ROWS, scanByEffectivePrice } from './effective-price';
import { PartsService } from './parts.service';
import * as presenter from './part.presenter';

const discounts = new DiscountService({} as never);

const sale = (over: Record<string, unknown> = {}) =>
  ({
    id: 'sale_1',
    title: 'Sale',
    description: null,
    discountType: SaleDiscountType.PERCENT,
    discountValue: new Prisma.Decimal(50),
    scopeType: SaleScopeType.PRODUCTS,
    startAt: new Date(0),
    endAt: null,
    isActive: true,
    priority: 0,
    deletedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    targets: [{ targetType: SaleScopeType.PRODUCTS, targetId: 'expensive' }],
    ...over,
  }) as never;

// 'expensive' is 300 000 raw but 150 000 on sale; 'mid' is 200 000.
const ROWS = [
  {
    id: 'cheap',
    priceUzs: new Prisma.Decimal(100_000),
    categoryId: 'c',
    sellerId: 's',
  },
  {
    id: 'mid',
    priceUzs: new Prisma.Decimal(200_000),
    categoryId: 'c',
    sellerId: 's',
  },
  {
    id: 'expensive',
    priceUzs: new Prisma.Decimal(300_000),
    categoryId: 'c',
    sellerId: 's',
  },
];
const db = (rows = ROWS) => ({
  catalogPart: { findMany: jest.fn().mockResolvedValue(rows) },
});

describe('scanByEffectivePrice', () => {
  it('sorts cheapest-first by the sale price, not the stored one', async () => {
    const scan = await scanByEffectivePrice(
      db() as never,
      discounts,
      [sale()],
      {},
      {
        sort: 'price_asc',
        skip: 0,
        take: 10,
      },
    );
    expect(scan!.pageIds).toEqual(['cheap', 'expensive', 'mid']);
    expect(scan!.min).toBe(100_000);
    expect(scan!.max).toBe(200_000);
  });

  it('sorts dearest-first the same way', async () => {
    const scan = await scanByEffectivePrice(
      db() as never,
      discounts,
      [sale()],
      {},
      {
        sort: 'price_desc',
        skip: 0,
        take: 10,
      },
    );
    expect(scan!.pageIds).toEqual(['mid', 'expensive', 'cheap']);
  });

  it('pages are stable: equal prices are ordered by id, pages do not overlap', async () => {
    const rows = ['b', 'a', 'd', 'c'].map((id) => ({
      id,
      priceUzs: new Prisma.Decimal(1000),
      categoryId: 'c',
      sellerId: 's',
    }));
    const page = (skip: number) =>
      scanByEffectivePrice(
        db(rows) as never,
        discounts,
        [sale()],
        {},
        {
          sort: 'price_asc',
          skip,
          take: 2,
        },
      );
    expect((await page(0))!.pageIds).toEqual(['a', 'b']);
    expect((await page(2))!.pageIds).toEqual(['c', 'd']);
  });

  it('applies a 99.99% sale once, and never a FIXED one that would zero the price', async () => {
    const steep = sale({ discountValue: new Prisma.Decimal(99.99) });
    const scan = await scanByEffectivePrice(
      db() as never,
      discounts,
      [steep],
      {},
      {
        sort: 'price_asc',
        skip: 0,
        take: 10,
      },
    );
    expect(scan!.prices).toContain(30); // 300 000 × 0.01 %, applied once
    const fixed = sale({
      discountType: SaleDiscountType.FIXED,
      discountValue: new Prisma.Decimal(400_000),
    });
    const kept = await scanByEffectivePrice(
      db() as never,
      discounts,
      [fixed],
      {},
      {
        sort: 'price_asc',
        skip: 0,
        take: 10,
      },
    );
    // A FIXED amount above the price leaves the price alone.
    expect(kept!.prices).toEqual([100_000, 200_000, 300_000]);
  });

  it('does nothing when no sale is running: the database order is already right', async () => {
    const prisma = db();
    expect(
      await scanByEffectivePrice(
        prisma as never,
        discounts,
        [],
        {},
        {
          sort: 'price_asc',
          skip: 0,
          take: 10,
        },
      ),
    ).toBeNull();
    expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
  });

  it('falls back to the stored price above the row bound', async () => {
    const many = Array.from({ length: MAX_PRICED_ROWS + 1 }, (_, i) => ({
      ...ROWS[0],
      id: `p${i}`,
    }));
    expect(
      await scanByEffectivePrice(
        db(many) as never,
        discounts,
        [sale()],
        {},
        {
          sort: 'price_asc',
          skip: 0,
          take: 10,
        },
      ),
    ).toBeNull();
  });
});

describe('PartsService.list with a sale running', () => {
  it('returns the page in visible-price order and the card price matches the sort price', async () => {
    const full = ROWS.map((r) => ({
      ...r,
      title: r.id,
      kind: 'SPARE_PART',
      images: ['https://cdn/x.png'],
      oemNumbers: [],
      gmNumbers: [],
      compatibilities: [],
      fitmentBindings: [],
    }));
    const findMany = jest.fn(async (args: any) =>
      args.select ? ROWS : full.filter((r) => args.where.id.in.includes(r.id)),
    );
    const prisma: any = {
      catalogPart: {
        findMany,
        count: jest.fn().mockResolvedValue(3),
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn(),
      },
      partCategory: { findMany: jest.fn().mockResolvedValue([]) },
      partBrand: { findMany: jest.fn().mockResolvedValue([]) },
      vehicle: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new PartsService(prisma, {
      loadActiveSales: jest.fn().mockResolvedValue([sale()]),
      calculateDiscount: discounts.calculateDiscount.bind(discounts),
    } as never);

    // The presenter is out of scope here: it echoes the id and the price the
    // card will show, which is the discount result the service hands it.
    jest.spyOn(presenter, 'presentPartItem').mockImplementation(((
      part: any,
      _v: unknown,
      discount: any,
    ) => ({
      id: part.id,
      final_price_uzs: discount.finalPrice,
    })) as never);

    const res: any = await service.list({ sort: 'price_asc' }, 'ru', null);

    expect(res.items.map((i: any) => i.id)).toEqual([
      'cheap',
      'expensive',
      'mid',
    ]);
    // Each card's price is the price it was sorted by.
    const shown = res.items.map((i: any) => i.final_price_uzs);
    expect(shown).toEqual([100_000, 150_000, 200_000]);
    expect(res.facets.price_range_uzs).toEqual({ min: 100_000, max: 200_000 });
    // The raw aggregate is not used for the range while a sale runs.
    expect(prisma.catalogPart.aggregate).not.toHaveBeenCalled();
  });
});
