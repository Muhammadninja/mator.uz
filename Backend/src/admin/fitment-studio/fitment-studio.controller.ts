/**
 * FitmentStudioController — admin routes for the 3D Fitment Studio.
 *
 * Mounted under `/v1/admin/fitment-studio`. Guarded the same way as the rest of
 * the admin surface (AdminJwtGuard + AdminRoleGuard, every operator role), so a
 * mobile app-user token cannot reach it. IDs are slugs, NOT UUIDs — no
 * ParseUUIDPipe anywhere.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';

import { Roles } from '../auth/decorators/roles.decorator';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { AdminRoleGuard } from '../auth/guards/admin-role.guard';
import { BindPartDto } from './dto/bind-part.dto';
import { GetUnmappedPartsQueryDto } from './dto/get-unmapped-parts-query.dto';
import { PropagateFitmentDto } from './dto/propagate-fitment.dto';
import { UnbindPartDto } from './dto/unbind-part.dto';
import { FitmentStudioService } from './fitment-studio.service';

@ApiTags('Admin Fitment Studio')
@ApiBearerAuth('jwt')
@Controller('v1/admin/fitment-studio')
@UseGuards(AdminJwtGuard, AdminRoleGuard)
@Roles(AdminRole.SUPER_ADMIN, AdminRole.MANAGER, AdminRole.OPERATOR)
export class FitmentStudioController {
  constructor(private readonly service: FitmentStudioService) {}

  /** Vehicle list for the make/model selectors. */
  @Get('vehicles')
  async vehicles() {
    return { success: true, data: await this.service.listVehicles() };
  }

  /** All 3D nodes for a vehicle (coords + completion + mapped parts). */
  @Get('vehicles/:vehicleModelId/nodes')
  async nodes(@Param('vehicleModelId') vehicleModelId: string) {
    return { success: true, data: await this.service.getNodes(vehicleModelId) };
  }

  /** Catalogue parts not yet bound to the selected vehicle + node. */
  @Get('unmapped-parts')
  async unmappedParts(@Query() query: GetUnmappedPartsQueryDto) {
    const { data, meta } = await this.service.getUnmappedParts(query);
    return { success: true, data, meta };
  }

  /** Create/update a fitment. */
  @Post('bind')
  async bind(@Body() dto: BindPartDto) {
    return { success: true, data: await this.service.bind(dto) };
  }

  /** Remove a fitment. */
  @Delete('unbind')
  async unbind(@Body() dto: UnbindPartDto) {
    return { success: true, data: await this.service.unbind(dto) };
  }

  /** Bulk-copy a node's fitment from one model to others. */
  @Post('propagate-node')
  async propagate(@Body() dto: PropagateFitmentDto) {
    return { success: true, data: await this.service.propagateNode(dto) };
  }
}
