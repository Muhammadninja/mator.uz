import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { MoveCategoryDto } from './dto/move-category.dto';

/**
 * Admin/operator Category-tree console. Admin-panel bearer token
 * (AdminJwtGuard, HS256) + role gate — a mobile app-user token cannot reach it.
 * SUPER_ADMIN, MANAGER and OPERATOR all pass, matching the dealers/brands
 * consoles.
 *
 * Manages the nesting of the EXISTING PartCategory taxonomy (the relational
 * category linked from CatalogPart.categoryId). Thin: each route validates its
 * input through a DTO and hands off to AdminCategoriesService.
 */
@ApiTags('Admin Categories')
@ApiBearerAuth('jwt')
@Controller('v1/admin/categories')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin access token.' })
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminCategoriesController {
  constructor(private readonly categories: AdminCategoriesService) {}

  @Get('tree')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Full nested category tree with direct product counts',
    description:
      'Returns the whole PartCategory forest. Each node carries productsCount ' +
      '(count of parts linked directly to that node) and its ordered children.',
  })
  @ApiOkResponse({ description: 'The category tree in the standard admin envelope.' })
  tree() {
    return this.categories.tree();
  }

  @Patch(':id/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Move a category under a new parent (or to root)',
    description:
      'parentId: null promotes to root. A move whose parent is the category ' +
      'itself or any of its descendants is rejected with 400 (cycle guard). ' +
      'sortOrder, when given, sets the order among the new siblings.',
  })
  @ApiOkResponse({ description: 'The updated category node.' })
  @ApiBadRequestResponse({ description: 'Invalid body or would create a cycle.' })
  @ApiNotFoundResponse({ description: 'No such category or target parent.' })
  move(@Param('id') id: string, @Body() dto: MoveCategoryDto) {
    return this.categories.move(id, dto);
  }
}
