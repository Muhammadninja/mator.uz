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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
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
  // service; gated on the ADMIN (operator) role — a customer can't self-advance
  // their own order. The class-level JwtAuthGuard authenticates; RolesGuard here
  // enforces the role (403 otherwise).
  @Patch(':id/status')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  updateStatus(
    @Request() req: { user: StatusActor },
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    // Pass the acting operator so the change is attributed in the status history.
    return this.orders.updateStatus(id, dto, req.user);
  }
}
