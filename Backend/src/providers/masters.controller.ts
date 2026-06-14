import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ProviderType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ProvidersService } from './providers.service';
import { BookingsService } from './bookings.service';
import { NearbyQueryDto } from './dto/nearby.query.dto';
import { CreateBookingDto } from './dto/create-booking.dto';

@Controller('v1/masters')
export class MastersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly bookings: BookingsService,
  ) {}

  // Declared before ':id' so the static path wins.
  @Get('nearby')
  @HttpCode(HttpStatus.OK)
  nearby(@Query() query: NearbyQueryDto) {
    return this.providers.nearby(ProviderType.MASTER, query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  detail(@Param('id') id: string) {
    return this.providers.detail(id);
  }

  @Post(':id/bookings')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  createBooking(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookings.create(req.user.id, id, dto);
  }
}
