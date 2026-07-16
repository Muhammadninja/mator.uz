// Integration tests for the Top Featured service (Phase 4B). Prisma is mocked —
// no DB. Guards: only active items served, sortOrder default order, equality
// filters + search, pagination math, presenter shape (null → '' / undefined),
// and derived availableFilters (from distinct values, matching ≥1 item).

import { TopFeaturedService, presentFeatured } from './top-featured.service';

function feat(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'f1', partId: null, badge: null, status: null, title: 'Cobalt SUV',
    description: null, priceUzs: null, model: 'SUV', brand: 'Cobalt',
    color: 'Black', condition: 'New', oem: 'GM 15823942', sortOrder: 0,
    isActive: true, createdAt: new Date('2026-07-16T10:00:00.000Z'),
    ...over,
  };
}

function makePrismaMock() {
  return {
    featuredItem: {
      count: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn(),
      aggregate: jest.fn(),
    },
  };
}

describe('TopFeaturedService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: TopFeaturedService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new TopFeaturedService(prisma as never);
    // Default stubs so list() resolves.
    prisma.featuredItem.count.mockResolvedValue(1);
    prisma.featuredItem.findMany.mockResolvedValue([feat()]);
    prisma.featuredItem.groupBy.mockResolvedValue([]);
    prisma.featuredItem.aggregate.mockResolvedValue({ _count: { _all: 1 }, _max: { createdAt: new Date('2026-07-16T10:00:00.000Z') } });
  });

  it('serves only active items, ordered by sortOrder by default', async () => {
    await service.list({});
    expect(prisma.featuredItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ isActive: true }] },
        orderBy: { sortOrder: 'asc' },
        skip: 0,
        take: 24,
      }),
    );
  });

  it('applies equality filters and search', async () => {
    await service.list({ filters: { brand: 'Cobalt', color: 'Black' }, search: 'sedan' });
    const call = prisma.featuredItem.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual(
      expect.arrayContaining([
        { isActive: true },
        { brand: 'Cobalt' },
        { color: 'Black' },
        expect.objectContaining({ OR: expect.any(Array) }),
      ]),
    );
  });

  it('paginates: page 2, pageSize 5 → skip 5 take 5', async () => {
    const res = await service.list({ page: 2, pageSize: 5 });
    expect(prisma.featuredItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, take: 5 }),
    );
    expect(res.page).toBe(2);
    expect(res.pageSize).toBe(5);
  });

  it('maps sortBy to orderBy', async () => {
    await service.list({ sortBy: 'price_desc' });
    expect(prisma.featuredItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { priceUzs: 'desc' } }),
    );
  });

  it('derives availableFilters from distinct values with counts, dropping nulls', async () => {
    prisma.featuredItem.groupBy.mockImplementation(({ by }: { by: string[] }) => {
      if (by[0] === 'brand') return Promise.resolve([
        { brand: 'Cobalt', _count: { _all: 2 } },
        { brand: 'BYD', _count: { _all: 1 } },
        { brand: null, _count: { _all: 3 } },
      ]);
      return Promise.resolve([]);
    });
    const res = await service.list({});
    const brand = res.availableFilters.find((g) => g.key === 'brand');
    expect(brand?.options).toEqual([
      { value: 'BYD', label: 'BYD', count: 1 },
      { value: 'Cobalt', label: 'Cobalt', count: 2 },
    ]);
    // null brand row is dropped, options sorted by value.
  });

  it('returns socketChannel and a content-derived snapshotVersion (hash)', async () => {
    const res = await service.list({});
    expect(res.socketChannel).toBe('top_featured:catalog');
    // featured-<count>-<16 hex chars>
    expect(res.snapshotVersion).toMatch(/^featured-\d+-[0-9a-f]{16}$/);
  });

  it('snapshotVersion is stable for identical data and changes when a field changes', async () => {
    const base = [feat({ id: 'f1', title: 'A' }), feat({ id: 'f2', title: 'B' })];
    prisma.featuredItem.findMany.mockResolvedValue(base);
    const v1 = (await service.list({})).snapshotVersion;
    const v2 = (await service.list({})).snapshotVersion;
    expect(v1).toBe(v2); // identical data → identical version

    // In-place edit of ONE field (no create/delete) must change the version.
    prisma.featuredItem.findMany.mockResolvedValue([feat({ id: 'f1', title: 'A-EDITED' }), feat({ id: 'f2', title: 'B' })]);
    const v3 = (await service.list({})).snapshotVersion;
    expect(v3).not.toBe(v1);
  });

  it('snapshotVersion changes when a row is CREATED', async () => {
    prisma.featuredItem.findMany.mockResolvedValue([feat({ id: 'f1' })]);
    const before = (await service.list({})).snapshotVersion;

    // Add a second active item — the version must move.
    prisma.featuredItem.findMany.mockResolvedValue([feat({ id: 'f1' }), feat({ id: 'f2' })]);
    const after = (await service.list({})).snapshotVersion;

    expect(after).not.toBe(before);
  });

  it('snapshotVersion changes when a row is DELETED', async () => {
    prisma.featuredItem.findMany.mockResolvedValue([feat({ id: 'f1' }), feat({ id: 'f2' })]);
    const before = (await service.list({})).snapshotVersion;

    // Remove one active item — the version must move.
    prisma.featuredItem.findMany.mockResolvedValue([feat({ id: 'f1' })]);
    const after = (await service.list({})).snapshotVersion;

    expect(after).not.toBe(before);
  });

  it('snapshotVersion is a pure function: reverting the data restores the exact version', async () => {
    const original = [feat({ id: 'f1', title: 'A' }), feat({ id: 'f2', title: 'B' })];
    prisma.featuredItem.findMany.mockResolvedValue(original);
    const v1 = (await service.list({})).snapshotVersion;

    // Mutate, then revert to byte-identical content.
    prisma.featuredItem.findMany.mockResolvedValue([feat({ id: 'f1', title: 'CHANGED' }), feat({ id: 'f2', title: 'B' })]);
    const vChanged = (await service.list({})).snapshotVersion;
    prisma.featuredItem.findMany.mockResolvedValue([feat({ id: 'f1', title: 'A' }), feat({ id: 'f2', title: 'B' })]);
    const vReverted = (await service.list({})).snapshotVersion;

    expect(vChanged).not.toBe(v1);
    expect(vReverted).toBe(v1); // same data → same version, regardless of history
  });

  it('snapshotVersion reads rows in a canonical id order (stable across DB row order)', async () => {
    // Order-independence comes from the DB sort, not the service: the version
    // query must always ask for `orderBy: { id: 'asc' }` so two runs over the
    // same set — whatever physical order the DB returns — hash identically.
    // (Asserting the query contract, since the mock does not itself sort.)
    await service.list({});
    const versionQuery = prisma.featuredItem.findMany.mock.calls.find(
      ([arg]) => arg?.orderBy?.id === 'asc',
    );
    expect(versionQuery).toBeDefined();
    expect(versionQuery![0]).toMatchObject({ where: { isActive: true }, orderBy: { id: 'asc' } });
  });

  it('snapshotVersion does not collide when content shifts across a field boundary', async () => {
    // Adjacent fields are joined with a NUL delimiter, so two datasets that would
    // serialize identically WITHOUT a delimiter must still get different versions.
    // {title:'AB', badge:'C'} and {title:'A', badge:'BC'} both concatenate to
    // "ABC" without a delimiter. If the delimiter is ever stripped, these two
    // versions collide and this assertion fails.
    prisma.featuredItem.findMany.mockResolvedValue([feat({ id: 'f1', title: 'AB', badge: 'C' })]);
    const vAB_C = (await service.list({})).snapshotVersion;

    prisma.featuredItem.findMany.mockResolvedValue([feat({ id: 'f1', title: 'A', badge: 'BC' })]);
    const vA_BC = (await service.list({})).snapshotVersion;

    expect(vAB_C).not.toBe(vA_BC);
  });

  it('empty table → items [], total 0, no error', async () => {
    prisma.featuredItem.count.mockResolvedValue(0);
    prisma.featuredItem.findMany.mockResolvedValue([]);
    const res = await service.list({});
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.snapshotVersion).toMatch(/^featured-0-[0-9a-f]{16}$/);
  });

  describe('presentFeatured', () => {
    it('null optionals become empty strings; oem null → undefined', () => {
      const r = presentFeatured(feat({ badge: null, status: null, description: null, priceUzs: null, oem: null }) as never);
      expect(r).toEqual(
        expect.objectContaining({ badge: '', status: '', description: '', price: '', oem: undefined }),
      );
    });

    it('formats priceUzs into a UZS label when present', () => {
      const r = presentFeatured(feat({ priceUzs: 850750 }) as never);
      expect(r.price).toMatch(/^UZS /);
    });
  });
});
