import { Controller, Get, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { PartsService } from './parts.service';
import { ListPartsQueryDto } from './dto/list-parts.query.dto';

@Controller('v1/catalog/parts')
export class PartsController {
  constructor(private readonly parts: PartsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  list(@Query() query: ListPartsQueryDto) {
    return this.parts.list(query);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  detail(@Param('id') id: string, @Query('vehicle_id') vehicleId?: string) {
    return this.parts.detail(id, vehicleId);
  }

  @Get(':id/compatibility')
  @HttpCode(HttpStatus.OK)
  compatibility(@Param('id') id: string, @Query('vehicle_id') vehicleId: string) {
    return this.parts.compatibility(id, vehicleId);
  }
}
