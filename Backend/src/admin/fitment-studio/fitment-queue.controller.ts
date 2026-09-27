/**
 * FitmentQueueController — the part-first Fitment Studio surface.
 *
 * Mounted at `/v1/admin/fitment` (the car-first routes keep
 * `/v1/admin/fitment-studio`), matching the admin client's `BASE` in
 * src/lib/fitment-queue-api.ts.
 *
 * Guarded by the same AdminJwtGuard + AdminRoleGuard stack as /v1/admin/orders,
 * so a non-admin token gets 401/403 — never 404. That distinction is load
 * bearing on the client: it reads 404 as "route not deployed" and silently
 * falls back to sample data, so answering 404 to a permissions problem would
 * hide it behind fake rows.
 */

import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';

import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { BindPartFitmentDto } from './dto/bind-part-fitment.dto';
import { GetPartsQueueQueryDto } from './dto/get-parts-queue-query.dto';
import { FitmentQueueService } from './fitment-queue.service';

@ApiTags('Admin Fitment Studio')
@ApiBearerAuth('jwt')
@Controller('v1/admin/fitment')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
export class FitmentQueueController {
  constructor(private readonly service: FitmentQueueService) {}

  /** The digitization conveyor: parts to bind, in a stable order. */
  @Get('parts-queue')
  async partsQueue(@Query() query: GetPartsQueueQueryDto) {
    const { data, meta } = await this.service.getPartsQueue(query);
    return { success: true, data, meta };
  }

  /** Bind one part to many vehicle models at one node (replaces the set). */
  @Post('bind')
  async bind(@Body() dto: BindPartFitmentDto) {
    return { success: true, data: await this.service.bindPart(dto) };
  }
}
