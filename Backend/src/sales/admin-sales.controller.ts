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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { Roles } from '../admin/auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../admin/auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../admin/auth/guards/admin-role.guard';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesQueryDto } from './dto/list-sales.query.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { SalesService } from './sales.service';

/**
 * Admin sales console (/v1/admin/sales). Admin-panel bearer token
 * (AdminJwtGuard, HS256) + role gate — a mobile app-user token cannot reach it
 * at all. Every admin role is an operator here: SUPER_ADMIN, MANAGER and
 * OPERATOR all pass, matching the dealers and orders consoles.
 *
 * Thin by construction: each route validates its input through a DTO and hands
 * off to SalesService. No discount arithmetic and no scope logic lives here —
 * that belongs to DiscountService, which other modules inject directly.
 */
@ApiTags('Admin Sales')
@ApiBearerAuth('jwt')
@Controller('v1/admin/sales')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
@ApiUnauthorizedResponse({
  description: 'Missing or invalid admin access token.',
})
@ApiForbiddenResponse({ description: 'Insufficient role for this operation.' })
export class AdminSalesController {
  constructor(private readonly sales: SalesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List sales (admin) — paginated, filterable, searchable',
    description:
      'Newest sales first by default. `status` filters on the DERIVED lifecycle ' +
      '(active / scheduled / expired / inactive / deleted), which is computed from ' +
      '`isActive`, `deletedAt` and the current time rather than stored — an expired ' +
      'campaign needs no sweeper job to stop applying. `search` matches the title, ' +
      'case-insensitively. `sort` accepts createdAt, startAt, endAt, title, priority ' +
      'or discountValue; anything else is rejected with 400.\n\n' +
      'Soft-deleted sales are hidden unless `includeDeleted=true` (implied by ' +
      '`status=deleted`).',
  })
  @ApiOkResponse({
    description: 'Paginated sales in the standard admin envelope.',
    schema: {
      example: {
        success: true,
        data: [
          {
            id: 'sale_01HXC3KF8Q2M4N6P8R0T2V4X6Z',
            title: 'Summer brake sale',
            description: '15% off all brake pads',
            discountType: 'PERCENT',
            discountValue: 15,
            scopeType: 'CATEGORIES',
            targetCount: 3,
            startAt: '2026-07-01T00:00:00.000Z',
            endAt: '2026-08-31T23:59:59.000Z',
            isActive: true,
            priority: 10,
            status: 'active',
            createdAt: '2026-06-28T09:12:00.000Z',
            updatedAt: '2026-06-28T09:12:00.000Z',
          },
        ],
        meta: { page: 1, limit: 20, totalItems: 1, totalPages: 1 },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid query parameter.' })
  list(@Query() query: ListSalesQueryDto) {
    return this.sales.list(query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get one sale (admin)',
    description:
      'A superset of the list row: the same fields plus `targetIds`, the ids of the ' +
      'products, categories or dealers this sale targets (empty for ALL_PRODUCTS).',
  })
  @ApiOkResponse({ description: 'The sale, including its target ids.' })
  @ApiNotFoundResponse({ description: 'No such sale.' })
  getOne(@Param('id') id: string) {
    return this.sales.getOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a sale (admin)',
    description:
      'The sale and its targets are written in one transaction. `scopeType` defaults ' +
      'to ALL_PRODUCTS, which takes no `targetIds`; PRODUCTS, CATEGORIES and DEALERS ' +
      'each require at least one, and every id must name a row that exists — a typo ' +
      'is a 400, not a sale that silently discounts nothing.\n\n' +
      'Validation: `discountValue` > 0 (and <= 100 for PERCENT), `endAt` >= `startAt`. ' +
      'Omit `endAt` for an open-ended campaign.\n\n' +
      'When several sales match one product exactly one is applied — they never stack — ' +
      'and `priority` is the only lever over which: higher wins, ties fall back to the ' +
      'older campaign then the lower id. Discount SIZE is not considered, so the same ' +
      'campaign wins for every product it covers regardless of price.',
  })
  @ApiCreatedResponse({ description: 'The created sale.' })
  @ApiBadRequestResponse({
    description:
      'Invalid discount value, invalid window, or a scope/targetIds mismatch.',
  })
  create(@Body() dto: CreateSaleDto) {
    return this.sales.create(dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a sale (admin)',
    description:
      'Partial update — send only the fields that change. Cross-field rules are ' +
      're-checked against the MERGED state, so "percent <= 100" and "endAt >= startAt" ' +
      'cannot be bypassed by splitting a change across two requests.\n\n' +
      'Targets are replaced only when `targetIds` is sent or `scopeType` changes; ' +
      'otherwise the existing target set is left intact. Setting `isActive: false` is ' +
      'the way to end a campaign while keeping it on file.',
  })
  @ApiOkResponse({ description: 'The updated sale.' })
  @ApiBadRequestResponse({
    description: 'Invalid field, invalid value, or a scope/targetIds mismatch.',
  })
  @ApiNotFoundResponse({ description: 'No such sale.' })
  update(@Param('id') id: string, @Body() dto: UpdateSaleDto) {
    return this.sales.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a sale (admin) — soft delete',
    description:
      'SOFT delete: the row is stamped with `deletedAt` rather than removed, so a ' +
      'campaign that ran stays on file and auditable (list it again with ' +
      '`?includeDeleted=true` or `?status=deleted`). Its targets stay attached.\n\n' +
      'The effect is immediate and total: a deleted sale disappears from both lists ' +
      'and never prices anything again. Deletion is terminal — fetching, editing or ' +
      're-deleting a deleted sale all 404.\n\n' +
      'Past orders are unaffected either way: an order item stores its own price ' +
      'snapshot and holds no reference to a sale. To pause a campaign you may want ' +
      'to run again, PATCH `isActive: false` instead — that is reversible, this is not.',
  })
  @ApiOkResponse({ description: 'The sale was soft-deleted.' })
  @ApiNotFoundResponse({ description: 'No such sale, or already deleted.' })
  remove(@Param('id') id: string) {
    return this.sales.remove(id);
  }
}
