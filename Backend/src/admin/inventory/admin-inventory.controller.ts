import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AdminInventoryService } from './admin-inventory.service';
import { BatchUpdateInventoryDto } from './dto/batch-update-inventory.dto';
import { ListInventoryQueryDto } from './dto/list-inventory.query.dto';

/**
 * Admin/operator Smart-Inventory console. Admin-panel bearer token
 * (AdminJwtGuard, HS256) + role gate — a mobile app-user token cannot reach it.
 * SUPER_ADMIN, MANAGER and OPERATOR all pass, matching the dealers/brands
 * consoles.
 *
 * Reads and batch-writes the inventory columns on the EXISTING buyer catalog
 * part (CatalogPart). Thin: each route validates its input through a DTO and
 * hands off to AdminInventoryService.
 */
@ApiTags('Admin Inventory')
@ApiBearerAuth('jwt')
@Controller('v1/admin/inventory')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin access token.' })
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminInventoryController {
  constructor(private readonly inventory: AdminInventoryService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Paginated inventory — searchable + filterable',
    description:
      'search is a case-insensitive contains across SKU, OEM number, name and ' +
      'cross/alias (GM) numbers. Filter by categoryId, brandId and stock ' +
      '(in_stock | low_stock | out_of_stock). Each row carries its derived ' +
      'stockStatus alongside the raw quantity and prices.',
  })
  @ApiOkResponse({ description: 'Paginated inventory in the standard admin envelope.' })
  list(@Query() query: ListInventoryQueryDto) {
    return this.inventory.list(query);
  }

  @Patch('batch-update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch-update inventory rows (transactional)',
    description:
      'Updates purchasePrice, retailPrice, cashbackPct and/or stock on many ' +
      'parts in a single transaction. Numbers are non-negative; cashbackPct is ' +
      'bounded 0–100. Returns the updated count.',
  })
  @ApiOkResponse({ description: 'The number of rows updated.' })
  @ApiBadRequestResponse({ description: 'Invalid body or out-of-range value.' })
  batchUpdate(@Body() dto: BatchUpdateInventoryDto) {
    return this.inventory.batchUpdate(dto);
  }
}
