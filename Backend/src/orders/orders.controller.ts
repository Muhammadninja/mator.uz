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
  Headers,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { parseIdempotencyKey } from './order-idempotency';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../admin/auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../admin/auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../admin/auth/guards/admin-role.guard';
import { AuthenticatedAdmin } from '../admin/auth/strategies/admin-jwt.strategy';
import { OrdersService, StatusActor } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders.query.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { RecordOfflineCollectionDto } from './dto/record-offline-collection.dto';
import { OfflineCollectionService } from './offline-collection.service';

@ApiTags('Orders')
@ApiBearerAuth('jwt')
// NOTE: authentication is declared PER ROUTE, not on the class. Nest guards are
// additive — a class-level @UseGuards runs BEFORE the method-level one and can
// only ever narrow access, never be replaced by it. With JwtAuthGuard on the
// class, the operator route below 401'd every admin token (HS256) inside the
// user strategy (RS256) before AdminJwtGuard was ever reached.
@Controller('v1/orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly offlineCollections: OfflineCollectionService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'One key per checkout. A retry with the same key and request returns the order already placed.',
  })
  async create(
    @Request() req: { user: { id: string } },
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const key = parseIdempotencyKey(rawKey);
    const { order, replayed } = await this.orders.checkout(
      req.user.id,
      dto,
      key,
    );
    // Same status and body as the first answer; this only tells a log or a test apart.
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return order;
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
  /**
   * The buyer's own unpaid order: cash or terminal while no money has been
   * collected, or online while it waits for payment. 409 ORDER_NOT_CANCELLABLE
   * once paid or taken up; idempotent once cancelled or expired.
   */
  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  cancel(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.orders.cancelOwnOrder(req.user.id, id);
  }

  @Patch(':id/status')
  @UseGuards(AdminJwtGuard, AdminRoleGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  updateStatus(
    @Request() req: ExpressRequest & { user: AuthenticatedAdmin },
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
      adminRole: req.user.role,
      email: req.user.email,
      displayName: req.user.name,
    };
    return this.orders.updateStatus(id, dto, actor, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  // Records cash or terminal money actually received. Open to exactly the roles that
  // may already confirm an offline order through the status route above.
  @Post(':id/offline-collection')
  @UseGuards(AdminJwtGuard, AdminRoleGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  recordOfflineCollection(
    @Request() req: ExpressRequest & { user: AuthenticatedAdmin },
    @Param('id') id: string,
    @Body() dto: RecordOfflineCollectionDto,
  ) {
    return this.offlineCollections.record(
      id,
      dto,
      { id: req.user.id, email: req.user.email, name: req.user.name },
      { ip: req.ip, userAgent: req.get('user-agent') },
    );
  }
}
