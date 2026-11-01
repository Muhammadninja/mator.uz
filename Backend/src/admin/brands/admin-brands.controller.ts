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
  ParseIntPipe,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { AuthenticatedAdmin } from '../auth/strategies/admin-jwt.strategy';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AdminBrandsService } from './admin-brands.service';
import { CreateAdminBrandDto } from './dto/create-admin-brand.dto';
import { CreateAdminModelDto } from './dto/create-admin-model.dto';
import { ListAdminBrandsQueryDto } from './dto/list-admin-brands.query.dto';
import { UpdateAdminBrandDto } from './dto/update-admin-brand.dto';

/**
 * Admin/operator vehicle-brands console. Admin-panel bearer token
 * (AdminJwtGuard, HS256) + role gate — a mobile app-user token cannot reach it.
 * SUPER_ADMIN, MANAGER and OPERATOR all pass, matching the dealers console.
 *
 * CRUD over the EXISTING VehicleMake / VehicleModelRef catalog (the buyer-facing
 * reference lists the app reads). Thin by construction: each route validates its
 * input through a DTO and hands off to AdminBrandsService, which owns slug
 * derivation, ordering and reference-cache invalidation.
 */
@ApiTags('Admin Brands')
@ApiBearerAuth('jwt')
@Controller('v1/admin/brands')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin access token.' })
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminBrandsController {
  constructor(private readonly brands: AdminBrandsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List brands (admin/operator) — paginated, searchable, sortable',
    description:
      'Alphabetical by default. `search` is a case-insensitive contains on the ' +
      'brand name. `sort` accepts name, createdAt or modelsCount; anything else ' +
      'is rejected with 400. Each row carries its models count.',
  })
  @ApiOkResponse({ description: 'Paginated brands in the standard admin envelope.' })
  list(@Query() query: ListAdminBrandsQueryDto) {
    return this.brands.list(query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get one brand with its models (admin/operator)',
    description:
      'The list row plus the brand’s models, ordered by sortOrder then name.',
  })
  @ApiOkResponse({ description: 'The brand and its models.' })
  @ApiNotFoundResponse({ description: 'No such brand.' })
  getOne(@Param('id') id: string) {
    return this.brands.getOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a brand (admin/operator)',
    description:
      'The slug id is derived from the name when omitted and made unique. Busts ' +
      'the app’s makes cache so the new brand appears immediately.',
  })
  @ApiOkResponse({ description: 'The created brand.' })
  @ApiBadRequestResponse({ description: 'Invalid body.' })
  @ApiConflictResponse({ description: 'A brand with this name already exists.' })
  create(@Body() dto: CreateAdminBrandDto) {
    return this.brands.create(dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a brand (admin/operator)',
    description:
      'Editable: name, logoUrl, country, isActive. Busts the app’s makes cache.',
  })
  @ApiOkResponse({ description: 'The updated brand.' })
  @ApiBadRequestResponse({ description: 'Invalid field or value.' })
  @ApiNotFoundResponse({ description: 'No such brand.' })
  @ApiConflictResponse({ description: 'A brand with this name already exists.' })
  update(@Param('id') id: string, @Body() dto: UpdateAdminBrandDto) {
    return this.brands.update(id, dto);
  }

  @Get(':id/delete-preview')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'What deleting a brand would take with it' })
  @ApiNotFoundResponse({ description: 'No such brand.' })
  deletePreview(@Param('id') id: string) {
    return this.brands.deletePreview(id);
  }

  @Delete(':id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a brand (manager or super admin)',
    description:
      'Models and their fitment bindings cascade, so if any bindings exist their ' +
      'number must be stated in ?acceptedFitmentLoss=. Blocked with 409 if a garage ' +
      'vehicle references the brand.',
  })
  @ApiOkResponse({ description: 'The deleted brand id.' })
  @ApiNotFoundResponse({ description: 'No such brand.' })
  @ApiConflictResponse({
    description: 'Vehicles reference this brand, or fitment would be lost.',
  })
  remove(
    @Param('id') id: string,
    @Query('acceptedFitmentLoss', new ParseIntPipe({ optional: true }))
    acceptedFitmentLoss: number | undefined,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.brands.remove(id, acceptedFitmentLoss, {
      actor: { id: req.user.id, email: req.user.email, name: req.user.name },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  @Post(':brandId/models')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a model under a brand (admin/operator)',
    description:
      'The slug id is derived from the name when omitted and made unique within ' +
      'the brand. Busts the brand’s models cache.',
  })
  @ApiOkResponse({ description: 'The created model.' })
  @ApiBadRequestResponse({ description: 'Invalid body.' })
  @ApiNotFoundResponse({ description: 'No such brand.' })
  @ApiConflictResponse({ description: 'A model with this name already exists.' })
  createModel(
    @Param('brandId') brandId: string,
    @Body() dto: CreateAdminModelDto,
  ) {
    return this.brands.createModel(brandId, dto);
  }
}
