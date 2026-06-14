import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';

@Controller('v1/orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req: { user: { id: string } }, @Body() dto: CreateOrderDto) {
    return this.orders.createFromCart(req.user.id, dto);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  get(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.orders.getOrder(req.user.id, id);
  }
}
