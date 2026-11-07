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
import {
  PickupPointsService,
  presentCartPickupPoint,
} from './pickup-points.service';

@ApiTags('Shipping')
@ApiBearerAuth('jwt')
@Controller('v1/shipping')
@UseGuards(JwtAuthGuard)
export class ShippingController {
  constructor(
    private readonly shipping: ShippingService,
    private readonly pickupPoints: PickupPointsService,
  ) {}

  @Get('pickup-points')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Where the goods in the caller's cart are collected, dealer by dealer",
    description:
      'One entry per dealer the cart buys from, in cart order: { dealer_id, dealer_name, ' +
      'address, landmark, location: { lat, lng } | null, items: [{ cart_item_id, part_id, ' +
      'title, quantity }] }. Each dealer appears once, with its own lines only; no other ' +
      "dealer's point is included. `address` and `location` are null when the dealer has " +
      'none on record (the pickup point is not specified yet): never a default. `landmark` ' +
      'is always null for now. Goods whose dealer cannot be found come last, with ' +
      'dealer_id null. Services are not listed. An empty cart answers an empty list.',
  })
  async pickupPointsOfCart(@Request() req: { user: { id: string } }) {
    const points = await this.pickupPoints.forCart(req.user.id);
    return { pickup_points: points.map(presentCartPickupPoint) };
  }

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
      "With delivery_method 'courier' and a saved delivery_address_id, answers both options: " +
      'pickup (always available, price_uzs 0) and courier, priced from each seller in the ' +
      'cart to that address. Each option is { type, label, available, price_uzs, quote_id, ' +
      'unavailable_reason }, in UZS. A courier that cannot be priced is available: false, ' +
      'price_uzs: null, and unavailable_reason { code, message } with code ' +
      'DELIVERY_ADDRESS_REQUIRED, DELIVERY_ADDRESS_COORDINATES_MISSING, ' +
      'COURIER_DELIVERY_UNAVAILABLE, DELIVERY_OUTSIDE_COVERAGE, PICKUP_LOCATION_MISSING, ' +
      'DELIVERY_ROUTE_NOT_FOUND or DELIVERY_ROUTING_UNAVAILABLE. The order is placed with ' +
      'the quote_id and the price from this answer. Without a method, the answer is pickup ' +
      'alone, as installed app builds expect. 404 for an address that is not the caller’s, ' +
      '400 for an empty cart.',
  })
  quote(
    @Request() req: { user: { id: string } },
    @Body() dto: ShippingQuoteDto,
  ) {
    return this.shipping.quote(req.user.id, dto);
  }
}
