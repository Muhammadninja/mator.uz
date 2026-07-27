import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AdminOrdersService } from './admin-orders.service';
import { ListAdminOrdersQueryDto } from './dto/list-admin-orders.query.dto';

/**
 * Admin/operator order console (read-only). Admin-panel bearer token
 * (AdminJwtGuard, HS256) + role gate — a mobile app-user token cannot reach it
 * at all. Every admin role is an operator here: SUPER_ADMIN, MANAGER and
 * OPERATOR all pass. These endpoints return orders across the ENTIRE system —
 * never scoped to the caller — and do not touch any customer-facing order
 * endpoint.
 */
@ApiTags('Admin Orders')
@ApiBearerAuth('jwt')
@Controller('v1/admin/orders')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
export class AdminOrdersController {
  constructor(private readonly adminOrders: AdminOrdersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'List all orders (admin/operator) — paginated, filterable, searchable',
  })
  list(@Query() query: ListAdminOrdersQueryDto) {
    return this.adminOrders.list(query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Get full order details (admin/operator), including status history',
  })
  getOne(@Param('id') id: string) {
    return this.adminOrders.getOne(id);
  }
}
