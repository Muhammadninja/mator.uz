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
import { ListCategoriesQueryDto } from './dto/list-categories.query.dto';
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
@ApiUnauthorizedResponse({
  description: 'Missing or invalid admin access token.',
})
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminCategoriesController {
  constructor(private readonly categories: AdminCategoriesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List categories (flat, filterable)',
    description:
      'Flat listing ordered by level, then sortOrder, then name. Filters ' +
      'combine with AND. parentId="null" (literal) selects root categories; ' +
      'omitting parentId applies no parent filter. Use GET /tree for the nested ' +
      'forest.',
  })
  @ApiOkResponse({
    description: 'Matching categories in the standard admin envelope.',
  })
  @ApiBadRequestResponse({ description: 'Invalid query parameter.' })
  list(@Query() query: ListCategoriesQueryDto) {
    return this.categories.list(query);
  }

  @Get('tree')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Full nested category tree with direct product counts',
    description:
      'Returns the whole PartCategory forest. Each node carries productsCount ' +
      '(count of parts linked directly to that node) and its ordered children.',
  })
  @ApiOkResponse({
    description: 'The category tree in the standard admin envelope.',
  })
  tree() {
    return this.categories.tree();
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get one category by id' })
  @ApiOkResponse({ description: 'The category node.' })
  @ApiNotFoundResponse({ description: 'No such category.' })
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
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
  @ApiBadRequestResponse({
    description: 'Invalid body or would create a cycle.',
  })
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
  @ApiOkResponse({
    description: 'Deletion result (deleted id + reassigned count).',
  })
  @ApiBadRequestResponse({ description: 'reassignTo equals the deleted id.' })
  @ApiConflictResponse({
    description: 'Parts still reference it and no reassignTo was given.',
  })
  @ApiNotFoundResponse({ description: 'No such category or reassign target.' })
  remove(@Param('id') id: string, @Query('reassignTo') reassignTo?: string) {
    return this.categories.remove(id, reassignTo);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activate a category',
    description:
      'Makes the category visible again in the buyer grid and to the Telegram ' +
      'seller bot. Invalidates the reference cache, so the bot sees it on the ' +
      'next read.',
  })
  @ApiOkResponse({ description: 'The updated category node.' })
  @ApiNotFoundResponse({ description: 'No such category.' })
  activate(@Param('id') id: string) {
    return this.categories.setActive(id, true);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a category (preferred over deletion)',
    description:
      'Hides the category from the buyer grid and the seller bot WITHOUT ' +
      'deleting it, so listings that reference it keep their taxonomy and the ' +
      'change is reversible. Deactivating a parent hides its whole subtree.',
  })
  @ApiOkResponse({ description: 'The updated category node.' })
  @ApiNotFoundResponse({ description: 'No such category.' })
  deactivate(@Param('id') id: string) {
    return this.categories.setActive(id, false);
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
  @ApiBadRequestResponse({
    description: 'Invalid body or would create a cycle.',
  })
  @ApiNotFoundResponse({ description: 'No such category or target parent.' })
  move(@Param('id') id: string, @Body() dto: MoveCategoryDto) {
    return this.categories.move(id, dto);
  }
}
