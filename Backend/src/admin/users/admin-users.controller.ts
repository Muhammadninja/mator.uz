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
import { AdminUsersService } from './admin-users.service';
import { ListAdminUsersQueryDto } from './dto/list-admin-users.query.dto';

/**
 * Admin/operator user console (read-only). Admin-panel bearer token
 * (AdminJwtGuard, HS256) + role gate, exactly like /v1/admin/orders — a mobile
 * app-user token cannot reach any of it, so a customer can never read another
 * customer's profile through here.
 *
 * Resource-oriented: the profile returns the user and their order summary only.
 * Addresses and the garage are separate endpoints, fetched by the panel when
 * that section is actually opened rather than on every profile load.
 */
@ApiTags('Admin Users')
@ApiBearerAuth('jwt')
@Controller('v1/admin/users')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List users (admin/operator) — paginated, searchable',
  })
  list(@Query() query: ListAdminUsersQueryDto) {
    return this.users.list(query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get one user (admin/operator): profile and order summary',
  })
  getOne(@Param('id') id: string) {
    return this.users.getOne(id);
  }

  @Get(':id/addresses')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Get one user's saved addresses (admin/operator)" })
  listAddresses(@Param('id') id: string) {
    return this.users.listAddresses(id);
  }

  @Get(':id/vehicles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Get one user's garage vehicles (admin/operator)" })
  listVehicles(@Param('id') id: string) {
    return this.users.listVehicles(id);
  }
}
