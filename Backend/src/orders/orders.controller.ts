import {
  Controller,
  Post,
  Get,
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
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders.query.dto';

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
}
