import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AdminCategoriesService } from './admin-categories.service';
import { AdminProductsRatingService } from '../products/admin-products-rating.service';
import { BulkMoveProductsDto } from './dto/bulk-move-products.dto';
import {
  ProductRatingResponseDto,
  UpdateProductRatingDto,
} from '../products/dto/update-product-rating.dto';

/**
 * Admin/operator product console at /v1/admin/products. Nest allows exactly one
 * controller per base path, so the routes here are grouped by path rather than
 * by domain, and each delegates to the service that owns its domain:
 *   • bulk-move    → AdminCategoriesService (a category operation)
 *   • :id/rating   → AdminProductsRatingService (curated product ratings)
 */
@ApiTags('Admin Categories')
@ApiBearerAuth('jwt')
@Controller('v1/admin/products')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin access token.' })
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminProductsController {
  constructor(
    private readonly categories: AdminCategoriesService,
    private readonly ratings: AdminProductsRatingService,
  ) {}

  @Patch('bulk-move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reassign many products to one category (transactional)',
    description:
      'Moves every listed part (CatalogPart) into targetCategoryId in a single ' +
      'transaction. Validates the target category exists. Returns the moved count.',
  })
  @ApiOkResponse({ description: 'The number of products moved.' })
  @ApiBadRequestResponse({ description: 'Invalid body.' })
  @ApiNotFoundResponse({ description: 'No such target category.' })
  bulkMove(@Body() dto: BulkMoveProductsDto) {
    return this.categories.bulkMoveProducts(dto);
  }

  @Patch(':id/rating')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Set or clear a product's curated rating",
    description:
      'Writes ratingAvg / reviewCount on the supply-side Product and immediately ' +
      're-projects its CatalogParts, so the buyer catalog shows the new values ' +
      'without a batch job. These are CURATED admin values, not user reviews. ' +
      'ratingAvg is 0.0–5.0 with one decimal place; an explicit null clears it ' +
      '(distinct from 0). Omitted fields are left unchanged.',
  })
  @ApiOkResponse({
    description: 'The persisted rating.',
    type: ProductRatingResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Out-of-range rating (<0 or >5), more than one decimal place, negative ' +
      'reviewCount, or an empty body.',
  })
  @ApiNotFoundResponse({ description: 'No such product.' })
  updateRating(
    // Product.id is an INT — ParseIntPipe rejects a non-numeric id with a 400
    // before any query runs, instead of letting Prisma throw on a bad cast.
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductRatingDto,
  ) {
    return this.ratings.updateRating(id, dto);
  }
}
