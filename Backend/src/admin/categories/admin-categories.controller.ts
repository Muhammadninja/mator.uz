import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AdminCategoriesService } from './admin-categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { MoveCategoryDto } from './dto/move-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

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

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a category',
    description:
      'The id equals the slug (derived from an explicit slug, else from the ' +
      'name), so a slug names one category. parentId omitted/null makes a root. ' +
      'Set mainCategory to surface the row in the buyer grid.',
  })
  @ApiCreatedResponse({ description: 'The created category node.' })
  @ApiBadRequestResponse({ description: 'Invalid body or unslugifiable name.' })
  @ApiConflictResponse({ description: 'Slug already in use.' })
  @ApiNotFoundResponse({ description: 'Parent category not found.' })
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a category (partial)',
    description:
      'Only provided fields are written. A parentId change reuses the cycle ' +
      'guard (parent = self or a descendant → 400). isActive toggles buyer-grid ' +
      'visibility.',
  })
  @ApiOkResponse({ description: 'The updated category node.' })
  @ApiBadRequestResponse({ description: 'Invalid body or would create a cycle.' })
  @ApiConflictResponse({ description: 'Slug already in use.' })
  @ApiNotFoundResponse({ description: 'No such category or target parent.' })
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a category (reassigning any parts first)',
    description:
      'If parts reference the category, pass ?reassignTo=<categoryId> to move ' +
      'them (both run in one transaction); otherwise a 409 reports the count. ' +
      'The Uncategorized bucket cannot be deleted.',
  })
  @ApiQuery({
    name: 'reassignTo',
    required: false,
    description: 'Category id to move referencing parts into before deletion.',
  })
  @ApiOkResponse({ description: 'Deletion result (deleted id + reassigned count).' })
  @ApiBadRequestResponse({ description: 'reassignTo equals the deleted id.' })
  @ApiConflictResponse({
    description: 'Parts still reference it and no reassignTo was given.',
  })
  @ApiNotFoundResponse({ description: 'No such category or reassign target.' })
  remove(@Param('id') id: string, @Query('reassignTo') reassignTo?: string) {
    return this.categories.remove(id, reassignTo);
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
