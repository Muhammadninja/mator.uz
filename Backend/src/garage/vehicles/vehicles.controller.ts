import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

@ApiTags('Garage / Vehicles')
@ApiBearerAuth('jwt')
@Controller('v1/garage/vehicles')
@UseGuards(JwtAuthGuard)
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  list(
    @Request() req: { user: { id: string } },
    @Query('include_deleted') includeDeleted?: string,
    @Query('include_3d') include3d?: string,
  ) {
    return this.vehicles.list(req.user.id, {
      includeDeleted: includeDeleted === 'true',
      include3d: include3d !== 'false', // default true
    });
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  getOne(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.vehicles.get(req.user.id, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req: { user: { id: string } }, @Body() dto: CreateVehicleDto) {
    return this.vehicles.create(req.user.id, dto);
  }

  @Post(':id/set-primary')
  @HttpCode(HttpStatus.OK)
  setPrimary(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.vehicles.setPrimary(req.user.id, id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  update(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    return this.vehicles.update(req.user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.vehicles.remove(req.user.id, id);
  }
}
