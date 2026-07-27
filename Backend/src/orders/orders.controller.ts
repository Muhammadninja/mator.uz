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
// NOTE: authentication is declared PER ROUTE, not on the class. Nest guards are
// additive — a class-level @UseGuards runs BEFORE the method-level one and can
// only ever narrow access, never be replaced by it. With JwtAuthGuard on the
// class, the operator route below 401'd every admin token (HS256) inside the
// user strategy (RS256) before AdminJwtGuard was ever reached.
@Controller('v1/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req: { user: { id: string } }, @Body() dto: CreateOrderDto) {
    return this.orders.createFromCart(req.user.id, dto);
  }

  // Order history (paginated, optional status filter). Declared before the
  // parameterized :id route for clarity; the paths are distinct regardless.
  @Get()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  list(@Request() req: { user: { id: string } }, @Query() query: ListOrdersQueryDto) {
    return this.orders.list(req.user.id, query);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  get(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.orders.getOrder(req.user.id, id);
  }

  // Operator status write. Server-authoritative state machine lives in the
  // service; gated on an admin-panel token ONLY — a customer can't self-advance
  // their own order. The operator console signs in through /v1/auth/admin, so
  // the caller carries an admin token (HS256), never a mobile app-user one; this
  // route therefore carries no JwtAuthGuard at all (see the class-level note).
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
