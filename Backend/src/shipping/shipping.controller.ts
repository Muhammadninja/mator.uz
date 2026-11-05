import {
  Controller,
  Get,
  Post,
  Body,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ShippingService } from './shipping.service';
import { ShippingQuoteDto } from './dto/shipping-quote.dto';

@ApiTags('Shipping')
@ApiBearerAuth('jwt')
@Controller('v1/shipping')
@UseGuards(JwtAuthGuard)
export class ShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Get('coverage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Whether couriers operate, and the exact area they cover',
  })
  coverage() {
    return this.shipping.coverage();
  }

  // Tighter than the global limit: an uncached quote costs a paid routing call per seller.
  @Post('quote')
  @Throttle({ default: { limit: 30, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Delivery options and prices for the caller's cart",
    description:
      "With delivery_method 'courier' and a saved delivery_address_id, prices courier " +
      'delivery from each seller in the cart to that address. The order is placed with the ' +
      'quote_id and the price from this answer. Refusals carry a code: 422 ' +
      'DELIVERY_ADDRESS_REQUIRED, DELIVERY_ADDRESS_COORDINATES_MISSING, ' +
      'COURIER_DELIVERY_UNAVAILABLE, DELIVERY_OUTSIDE_COVERAGE, PICKUP_LOCATION_MISSING or ' +
      'DELIVERY_ROUTE_NOT_FOUND; 503 ' +
      'DELIVERY_ROUTING_UNAVAILABLE.',
  })
  quote(
    @Request() req: { user: { id: string } },
    @Body() dto: ShippingQuoteDto,
  ) {
    return this.shipping.quote(req.user.id, dto);
  }
}
