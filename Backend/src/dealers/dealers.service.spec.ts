// Integration tests for the MATOR Certified dealers service (Phase 4C). Prisma
// is mocked — no DB. Guards: only curated dealers (isCurated = true) are
// queried — identity is the explicit flag, NOT storefront-field presence — with
// a stable id order, the presenter maps to the frontend MatorDealer shape with
// safe fallbacks, and an empty result is handled cleanly.

import { DealersService, presentDealer } from './dealers.service';

function seller(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'd1', name: 'AutoPro Parts', ratingAvg: 0, logoUrl: null,
    internalSellerId: null, isCurated: true,
    initial: 'A', color: '#2A6FDB', orders: '18k+', years: 12,
    ...over,
  };
}

function makePrismaMock() {
  return { catalogSeller: { findMany: jest.fn() } };
}

describe('DealersService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: DealersService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new DealersService(prisma as never);
  });

  it('queries only curated dealers (isCurated = true), ordered by id', async () => {
    prisma.catalogSeller.findMany.mockResolvedValue([seller()]);
    await service.list();
    expect(prisma.catalogSeller.findMany).toHaveBeenCalledWith({
      where: { isCurated: true },
      orderBy: { id: 'asc' },
    });
  });

  it('identifies dealers by the isCurated flag, NOT by storefront-field presence', async () => {
    // Regression guard for the leak found in Phase 4C smoke testing: a projected
    // seller_<id> row that acquires a non-empty `initial` must still be excluded.
    // The service must never filter on field presence — only on the flag.
    prisma.catalogSeller.findMany.mockResolvedValue([]);
    await service.list();
    const where = prisma.catalogSeller.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ isCurated: true });
    expect(where).not.toHaveProperty('initial');
  });

  it('maps rows to the frontend MatorDealer shape', async () => {
    prisma.catalogSeller.findMany.mockResolvedValue([
      seller(),
      seller({ id: 'd2', name: 'Prime Motors Supply', initial: 'P', color: '#1F8A5B', orders: '9.4k+', years: 8 }),
    ]);
    const res = await service.list();
    expect(res.items).toEqual([
      { id: 'd1', name: 'AutoPro Parts', initial: 'A', color: '#2A6FDB', orders: '18k+', years: 12 },
      { id: 'd2', name: 'Prime Motors Supply', initial: 'P', color: '#1F8A5B', orders: '9.4k+', years: 8 },
    ]);
    // ratingAvg / logoUrl / internalSellerId are NOT leaked into the dealer shape.
    expect(res.items[0]).not.toHaveProperty('ratingAvg');
  });

  it('returns an empty list without error when there are no curated dealers', async () => {
    prisma.catalogSeller.findMany.mockResolvedValue([]);
    const res = await service.list();
    expect(res).toEqual({ items: [] });
  });

  describe('presentDealer', () => {
    it('falls back safely when optional fields are null', () => {
      const r = presentDealer(seller({ initial: null, color: null, orders: null, years: null }) as never);
      expect(r).toEqual({ id: 'd1', name: 'AutoPro Parts', initial: '', color: '', orders: '', years: 0 });
    });
  });
});
