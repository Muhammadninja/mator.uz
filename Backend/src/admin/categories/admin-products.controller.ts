import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
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
import { BulkMoveProductsDto } from './dto/bulk-move-products.dto';

/**
 * Admin/operator bulk product-move console. A distinct controller base path
 * (/v1/admin/products) is required by Nest, but the operation belongs to the
 * category domain, so it shares AdminCategoriesService.
 */
@ApiTags('Admin Categories')
@ApiBearerAuth('jwt')
@Controller('v1/admin/products')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin access token.' })
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminProductsController {
  constructor(private readonly categories: AdminCategoriesService) {}

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
}
