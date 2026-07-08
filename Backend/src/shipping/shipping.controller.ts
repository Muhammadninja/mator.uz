import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ShippingService } from './shipping.service';
import { ShippingQuoteDto } from './dto/shipping-quote.dto';

@ApiTags('Shipping')
@ApiBearerAuth('jwt')
@Controller('v1/shipping')
@UseGuards(JwtAuthGuard)
export class ShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  quote(@Body() dto: ShippingQuoteDto) {
    return this.shipping.quote(dto);
  }
}
