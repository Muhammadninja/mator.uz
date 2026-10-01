/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the Prisma harness (test/utils/harness.ts) is untyped by design, like the other harness-based specs */
// A SUSPENDED dealer's parts leave every buyer-facing read; PENDING (the
// default for projected Telegram storefronts) stays visible. Listing and
// counts are evaluated over in-memory parts (where-eval); Prisma is mocked.

import { NotFoundException } from '@nestjs/common';
import { PartsService } from './parts/parts.service';
import { CategoriesService } from './categories/categories.service';
import { SearchService } from './search/search.service';
import { BUYER_VISIBLE_PART } from './buyer-visibility';
import { selectIds } from './compatibility/where-eval.test-util';
import * as fx from './compatibility/fitment-fixtures.test-util';
import { createPrismaMock, PrismaMock } from '../../test/utils/harness';

const PARTS = [
  fx.part({ id: 'pending_dealer_part', isUniversal: true }),
  fx.part({
    id: 'active_dealer_part',
    isUniversal: true,
    sellerStatus: 'ACTIVE',
  }),
  fx.part({
    id: 'suspended_dealer_part',
    isUniversal: true,
    sellerStatus: 'SUSPENDED',
  }),
].map((p) => ({ ...p, mainCategory: 'BRAKES' }));

const noDiscounts = {
  loadActiveSales: jest.fn().mockResolvedValue([]),
  calculateDiscount: (price: number) => ({
    originalPrice: price,
    finalPrice: price,
    discountAmount: 0,
    discountPercent: 0,
    appliedSale: null,
  }),
};

describe('buyer visibility — suspended dealers', () => {
  let prisma: PrismaMock;
  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.catalogPart.aggregate.mockResolvedValue({ _min: {}, _max: {} });
  });

  it('GET /v1/catalog/parts never lists a suspended dealer part', async () => {
    const svc = new PartsService(prisma, noDiscounts as never);
    await svc.list({});
    const { where } = prisma.catalogPart.findMany.mock.calls[0][0];
    expect(selectIds(PARTS, where)).toEqual([
      'pending_dealer_part',
      'active_dealer_part',
    ]);
  });

  it('…also when a garage vehicle filters the listing', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(
      fx.vehicleRow(fx.VEHICLES.cobalt),
    );
    const svc = new PartsService(prisma, noDiscounts as never);
    await svc.list({ vehicle_id: 'veh_1' });
    const { where } = prisma.catalogPart.findMany.mock.calls[0][0];
    expect(selectIds(PARTS, where)).not.toContain('suspended_dealer_part');
  });

  it('the part detail of a suspended dealer 404s', async () => {
    prisma.catalogPart.findFirst.mockResolvedValue(null);
    const svc = new PartsService(prisma, noDiscounts as never);
    await expect(svc.detail('suspended_dealer_part')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.catalogPart.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'suspended_dealer_part', ...BUYER_VISIBLE_PART },
      }),
    );
  });

  it('category counts exclude a suspended dealer part', async () => {
    prisma.partCategory.findMany.mockResolvedValue([
      {
        id: 'brakes',
        name: 'Brakes',
        nameRu: 'Т',
        nameUz: 'T',
        nameEn: 'B',
        slug: 'brakes',
        mainCategory: 'BRAKES',
      },
    ]);
    prisma.catalogPart.groupBy.mockImplementation(
      ({ where }: { where: unknown }) =>
        Promise.resolve([
          {
            mainCategory: 'BRAKES',
            _count: { _all: selectIds(PARTS, where).length },
          },
        ]),
    );
    const res = await new CategoriesService(prisma).list({});
    expect(res.items[0].count).toBe(2);
  });

  it('search, typeahead and quick filters carry the visibility filter', async () => {
    prisma.catalogPart.findMany.mockResolvedValue([]);
    prisma.catalogPart.groupBy.mockResolvedValue([]);
    prisma.partCategory.findMany.mockResolvedValue([]);
    prisma.partBrand.findMany.mockResolvedValue([]);
    const svc = new SearchService(prisma);

    await svc.search({ query: 'pads' });
    const searchWhere = prisma.catalogPart.count.mock.calls[0][0].where;
    expect(searchWhere.AND).toContainEqual(BUYER_VISIBLE_PART);

    await svc.typeahead('pads');
    const typeaheadWhere =
      prisma.catalogPart.findMany.mock.calls.at(-1)[0].where;
    expect(typeaheadWhere).toMatchObject(BUYER_VISIBLE_PART);

    await svc.quickFilters();
    const quickWhere = prisma.catalogPart.groupBy.mock.calls.at(-1)[0].where;
    expect(quickWhere).toMatchObject(BUYER_VISIBLE_PART);
  });
});
