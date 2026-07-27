import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../admin/auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../admin/auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../admin/auth/guards/admin-role.guard';
import { AuthenticatedAdmin } from '../admin/auth/strategies/admin-jwt.strategy';
import { OrdersService, StatusActor } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders.query.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@ApiTags('Orders')
@ApiBearerAuth('jwt')
@Controller('v1/orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req: { user: { id: string } }, @Body() dto: CreateOrderDto) {
    return this.orders.createFromCart(req.user.id, dto);
  }

  // Order history (paginated, optional status filter). Declared before the
  // parameterized :id route for clarity; the paths are distinct regardless.
  @Get()
  @HttpCode(HttpStatus.OK)
  list(@Request() req: { user: { id: string } }, @Query() query: ListOrdersQueryDto) {
    return this.orders.list(req.user.id, query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  get(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.orders.getOrder(req.user.id, id);
  }

  // Operator status write. Server-authoritative state machine lives in the
  // service; gated on an admin-panel token — a customer can't self-advance their
  // own order. These method-level guards REPLACE the class-level JwtAuthGuard
  // for this route only: the operator console signs in through /v1/auth/admin,
  // so the caller carries an admin token (HS256), not a mobile app-user one.
  // Every admin role is an operator here; AdminRoleGuard 403s anything else.
  @Patch(':id/status')
  @UseGuards(AdminJwtGuard, AdminRoleGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  updateStatus(
    @Request() req: { user: AuthenticatedAdmin },
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    // Pass the acting operator so the change is attributed in the status
    // history. AuthenticatedAdmin carries a single `name`, mapped onto the
    // actor's displayName; role stays 'ADMIN' so the history keeps recording
    // these as ADMIN transitions exactly as before.
    const actor: StatusActor = {
      id: req.user.id,
      role: 'ADMIN',
      displayName: req.user.name,
    };
    return this.orders.updateStatus(id, dto, actor);
  }
}
