import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import { UpdateProductRatingDto } from './dto/update-product-rating.dto';

/**
 * Admin/operator CURATED product ratings. Backs
 * PATCH /v1/admin/products/:id/rating.
 *
 * There is no review subsystem and this service is not one: nothing stores an
 * individual review, nothing aggregates anything, and no app user can write
 * here. An operator types the two numbers and they are stored verbatim.
 *
 * The write lands on the supply-side {@link Prisma.ProductUpdateInput} (Product
 * is the source of truth), then the affected buyer-side CatalogParts are
 * re-projected through the EXISTING {@link CatalogProjectionService} — the one
 * bridge between the two bounded contexts. That is what makes the new rating
 * visible to buyers immediately, with no batch job, and without CatalogPart
 * gaining a join back to Product.
 */
@Injectable()
export class AdminProductsRatingService {
  private readonly logger = new Logger(AdminProductsRatingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: CatalogProjectionService,
  ) {}

  /**
   * Set (or clear) a product's curated rating and immediately re-project it.
   *
   * `ratingAvg: null` clears the rating; an omitted field is left untouched, so
   * an operator can edit the count without restating the average. A body with
   * neither field is a 400 rather than a silent no-op — it is always a client
   * bug, and answering 200 would report success for a write that never happened.
   */
  async updateRating(productId: number, dto: UpdateProductRatingDto) {
    const data: Prisma.ProductUpdateInput = {};

    // `in` rather than `!== undefined`: an explicit `ratingAvg: null` MUST be
    // distinguishable from an absent key, since null is the clear operation.
    if ('ratingAvg' in dto) {
      data.ratingAvg =
        dto.ratingAvg === null || dto.ratingAvg === undefined
          ? null
          : new Prisma.Decimal(dto.ratingAvg);
    }
    if (dto.reviewCount !== undefined) {
      data.reviewCount = dto.reviewCount;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'Provide ratingAvg and/or reviewCount to update.',
      );
    }

    let product: {
      id: number;
      ratingAvg: Prisma.Decimal | null;
      reviewCount: number;
    };
    try {
      product = await this.prisma.product.update({
        where: { id: productId },
        data,
        select: { id: true, ratingAvg: true, reviewCount: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException(`No product with id ${productId}`);
      }
      throw err;
    }

    // Push the new values into the buyer catalog NOW. Failure here leaves the
    // supply-side truth correct and the projection briefly stale, which the next
    // projection of the same stock reconciles — so it is logged rather than
    // failing a write that already committed.
    try {
      await this.projection.projectProduct(product.id);
    } catch (err) {
      this.logger.error(
        `Rating saved for product ${product.id} but re-projection failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      success: true,
      data: {
        id: product.id,
        // Unwrap the Prisma Decimal so the response is a number, never a string
        // or a Decimal object — the same rule the buyer presenter follows.
        ratingAvg:
          product.ratingAvg === null ? null : Number(product.ratingAvg),
        reviewCount: product.reviewCount,
      },
    };
  }
}
