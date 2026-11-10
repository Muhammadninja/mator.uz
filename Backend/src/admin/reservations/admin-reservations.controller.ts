import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { AuthenticatedAdmin } from '../auth/strategies/admin-jwt.strategy';
import { AdminReservationsService } from './admin-reservations.service';
import {
  ListReservationsQueryDto,
  ListShortagesQueryDto,
  ReservationActionDto,
  RestockReservationDto,
} from './dto/admin-reservations.dto';

type AdminRequest = Request & { user: AuthenticatedAdmin };

const context = (req: AdminRequest) => ({
  actor: { id: req.user.id, email: req.user.email, name: req.user.name },
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

/** The same roles as the inventory console it sits beside. */
@ApiTags('Admin Inventory Reservations')
@ApiBearerAuth('jwt')
@Controller('v1/admin/inventory-reservations')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
export class AdminReservationsController {
  constructor(private readonly reservations: AdminReservationsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reservations, by view (active, long_held, needs_review, …)',
  })
  list(@Query() query: ListReservationsQueryDto) {
    return this.reservations.list(query);
  }

  @Get('summary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'How many reservations are in each state that needs attention',
  })
  summary() {
    return this.reservations.summary();
  }

  @Get('shortages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Checkouts refused for quantity, and their sourcing tickets',
  })
  shortages(@Query() query: ListShortagesQueryDto) {
    return this.reservations.shortages(query);
  }

  @Post(':id/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm the supplier’s count now includes this sale',
  })
  reconcile(
    @Param('id') id: string,
    @Body() dto: ReservationActionDto,
    @Req() req: AdminRequest,
  ) {
    return this.reservations.reconcile(id, dto.reason.trim(), context(req));
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close a reservation left open on an order that has ended',
  })
  release(
    @Param('id') id: string,
    @Body() dto: ReservationActionDto,
    @Req() req: AdminRequest,
  ) {
    return this.reservations.release(id, dto.reason.trim(), context(req));
  }

  @Post(':id/restock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Put returned units back on sale' })
  restock(
    @Param('id') id: string,
    @Body() dto: RestockReservationDto,
    @Req() req: AdminRequest,
  ) {
    return this.reservations.restock(
      id,
      dto.quantity,
      dto.reason.trim(),
      context(req),
    );
  }
}
