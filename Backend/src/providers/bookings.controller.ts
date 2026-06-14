import { Controller, Post, Param, Request, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BookingsService } from './bookings.service';

/** Provider-agnostic booking lifecycle (works for both masters and STOs). */
@Controller('v1/bookings')
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.bookings.confirm(req.user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.bookings.cancel(req.user.id, id);
  }
}
