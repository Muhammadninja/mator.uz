import { Controller, Get, HttpCode, HttpStatus, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AdminOrdersService } from './admin-orders.service';
import { ListAdminOrdersQueryDto } from './dto/list-admin-orders.query.dto';

/**
 * Admin/operator order console (read-only). Bearer JWT + role gate: only ADMIN
 * passes — ADMIN is the operator role in this system (the `Role` enum is
 * USER/SELLER/ADMIN; there is no separate OPERATOR value). A USER is rejected
 * with 403. These endpoints return orders across the ENTIRE system — never
 * scoped to the caller — and do not touch any customer-facing order endpoint.
 */
@ApiTags('Admin Orders')
@ApiBearerAuth('jwt')
@Controller('v1/admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminOrdersController {
  constructor(private readonly adminOrders: AdminOrdersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List all orders (admin/operator) — paginated, filterable, searchable' })
  list(@Query() query: ListAdminOrdersQueryDto) {
    return this.adminOrders.list(query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get full order details (admin/operator), including status history' })
  getOne(@Param('id') id: string) {
    return this.adminOrders.getOne(id);
  }
}
