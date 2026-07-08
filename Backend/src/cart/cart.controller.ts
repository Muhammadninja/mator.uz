import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CartService } from './cart.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { ApplyPromoDto } from './dto/apply-promo.dto';

@ApiTags('Cart')
@ApiBearerAuth('jwt')
@Controller('v1/cart')
@UseGuards(JwtAuthGuard)
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  get(@Request() req: { user: { id: string } }) {
    return this.cart.snapshot(req.user.id);
  }

  @Post('items')
  @HttpCode(HttpStatus.OK)
  addItem(@Request() req: { user: { id: string } }, @Body() dto: AddCartItemDto) {
    return this.cart.addItem(req.user.id, dto);
  }

  @Patch('items/:itemId')
  @HttpCode(HttpStatus.OK)
  updateItem(
    @Request() req: { user: { id: string } },
    @Param('itemId') itemId: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    return this.cart.updateItem(req.user.id, itemId, dto.quantity);
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.OK)
  removeItem(@Request() req: { user: { id: string } }, @Param('itemId') itemId: string) {
    return this.cart.removeItem(req.user.id, itemId);
  }

  @Post('clear')
  @HttpCode(HttpStatus.OK)
  clear(@Request() req: { user: { id: string } }) {
    return this.cart.clear(req.user.id);
  }

  @Post('promo')
  @HttpCode(HttpStatus.OK)
  applyPromo(@Request() req: { user: { id: string } }, @Body() dto: ApplyPromoDto) {
    return this.cart.applyPromo(req.user.id, dto.code);
  }

  @Delete('promo')
  @HttpCode(HttpStatus.OK)
  removePromo(@Request() req: { user: { id: string } }) {
    return this.cart.removePromo(req.user.id);
  }
}
