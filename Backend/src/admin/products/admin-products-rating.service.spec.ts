// Unit tests for AdminProductsRatingService (PATCH /v1/admin/products/:id/rating).
// Prisma and CatalogProjectionService are doubles. These pin the CURATED-rating
// contract: the write lands on the supply-side Product, an explicit null clears
// the rating (distinct from 0), omitted fields are left untouched, and the buyer
// catalog is re-projected IMMEDIATELY so no batch job is needed.
//
// Range/precision validation lives in the DTO (class-validator) and is asserted
// in the DTO spec; these tests cover the service's own behaviour.

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminProductsRatingService } from './admin-products-rating.service';
import { createPrismaMock, PrismaMock } from '../../../test/utils/harness';

function build() {
  const prisma: PrismaMock = createPrismaMock();
  const projection = {
    projectProduct: jest.fn().mockResolvedValue(['part_stock_1']),
  };
  const service = new AdminProductsRatingService(
    prisma as never,
    projection as never,
  );
  return { service, prisma, projection };
}

function resolvesTo(
  prisma: PrismaMock,
  ratingAvg: unknown,
  reviewCount: number,
) {
  prisma.product.update.mockResolvedValue({ id: 7, ratingAvg, reviewCount });
}

describe('AdminProductsRatingService.updateRating', () => {
  it('writes the rating onto the supply-side Product', async () => {
    const { service, prisma } = build();
    resolvesTo(prisma, new Prisma.Decimal('4.7'), 123);

    await service.updateRating(7, { ratingAvg: 4.7, reviewCount: 123 });

    const call = prisma.product.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 7 });
    expect(Number(call.data.ratingAvg)).toBe(4.7);
    expect(call.data.reviewCount).toBe(123);
  });

  it('returns rating_avg as a NUMBER, never a Decimal or string', async () => {
    const { service, prisma } = build();
    resolvesTo(prisma, new Prisma.Decimal('4.7'), 123);

    const res: any = await service.updateRating(7, {
      ratingAvg: 4.7,
      reviewCount: 123,
    });

    expect(res.data.ratingAvg).toBe(4.7);
    expect(typeof res.data.ratingAvg).toBe('number');
    expect(res.data.reviewCount).toBe(123);
  });

  it('an explicit null CLEARS the rating (distinct from 0)', async () => {
    const { service, prisma } = build();
    resolvesTo(prisma, null, 0);

    const res: any = await service.updateRating(7, {
      ratingAvg: null,
      reviewCount: 0,
    });

    expect(prisma.product.update.mock.calls[0][0].data.ratingAvg).toBeNull();
    expect(res.data.ratingAvg).toBeNull();
  });

  it('stores 0 as a real rating, not as "unrated"', async () => {
    const { service, prisma } = build();
    resolvesTo(prisma, new Prisma.Decimal('0'), 1);

    const res: any = await service.updateRating(7, {
      ratingAvg: 0,
      reviewCount: 1,
    });

    expect(
      prisma.product.update.mock.calls[0][0].data.ratingAvg,
    ).not.toBeNull();
    expect(res.data.ratingAvg).toBe(0);
  });

  it('leaves an omitted field untouched', async () => {
    const { service, prisma } = build();
    resolvesTo(prisma, new Prisma.Decimal('4.0'), 9);

    await service.updateRating(7, { reviewCount: 9 });

    const data = prisma.product.update.mock.calls[0][0].data;
    expect(data.reviewCount).toBe(9);
    expect('ratingAvg' in data).toBe(false);
  });

  it('re-projects the product into the buyer catalog immediately', async () => {
    const { service, prisma, projection } = build();
    resolvesTo(prisma, new Prisma.Decimal('4.7'), 123);

    await service.updateRating(7, { ratingAvg: 4.7 });

    // Through the EXISTING projection service — no second mapping, and no batch
    // job between the admin edit and the buyer catalog.
    expect(projection.projectProduct).toHaveBeenCalledWith(7);
  });

  it('still succeeds when re-projection fails (the write already committed)', async () => {
    const { service, prisma, projection } = build();
    resolvesTo(prisma, new Prisma.Decimal('4.7'), 123);
    projection.projectProduct.mockRejectedValue(new Error('projection down'));

    const res: any = await service.updateRating(7, { ratingAvg: 4.7 });

    expect(res.success).toBe(true);
  });

  it('400s on an empty body rather than reporting a write that never happened', async () => {
    const { service } = build();
    await expect(service.updateRating(7, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s for an unknown product (Prisma P2025)', async () => {
    const { service, prisma } = build();
    prisma.product.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('nf', {
        code: 'P2025',
        clientVersion: 'x',
      }),
    );

    await expect(
      service.updateRating(404, { ratingAvg: 4.7 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
