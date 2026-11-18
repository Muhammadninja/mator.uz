import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  UseGuards,
  Req,
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
import type { Request } from 'express';
import { AuthenticatedAdmin } from '../auth/strategies/admin-jwt.strategy';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AdminInventoryDeleteService } from './admin-inventory-delete.service';
import { AdminInventoryService } from './admin-inventory.service';
import { BatchDeleteInventoryDto } from './dto/batch-delete-inventory.dto';
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
  constructor(
    private readonly inventory: AdminInventoryService,
    private readonly deletion: AdminInventoryDeleteService,
  ) {}

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
  batchUpdate(
    @Body() dto: BatchUpdateInventoryDto,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.inventory.batchUpdate(dto, {
      actor: { id: req.user.id, email: req.user.email, name: req.user.name },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  @Post('batch-delete')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER)
  @ApiOperation({
    summary: 'Delete parts for good (transactional)',
    description:
      'Deletes the listed parts from the catalog together with the seller Stock ' +
      'row each was projected from, and that Product when no other seller lists ' +
      'it, so the part does not come back on re-projection. Cart lines and ' +
      'per-product sale targets naming a part go too; orders keep their copy. ' +
      'A part with units reserved for an open order is skipped and returned in ' +
      '`reserved`; ids that do not exist are returned in `missing`. Each deleted ' +
      'part is audited with what it was. SUPER_ADMIN and MANAGER only.',
  })
  @ApiOkResponse({ description: '{ deleted, reserved[], missing[] }.' })
  @ApiBadRequestResponse({ description: 'Invalid body.' })
  batchDelete(
    @Body() dto: BatchDeleteInventoryDto,
    @Req() req: Request & { user: AuthenticatedAdmin },
  ) {
    return this.deletion.batchDelete(dto, {
      actor: { id: req.user.id, email: req.user.email, name: req.user.name },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  }
}
