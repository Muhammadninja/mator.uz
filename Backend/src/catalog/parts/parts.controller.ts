import { Controller, Get, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PartsService } from './parts.service';
import { ListPartsQueryDto } from './dto/list-parts.query.dto';

@ApiTags('Catalog / Parts')
@Controller('v1/catalog/parts')
export class PartsController {
  constructor(private readonly parts: PartsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Faceted parts catalog',
    description:
      'Server-side filtering by category (main or vehicle-specific), make, model, part brand, region of origin, GM-only, OEM-only, in-stock, and garage vehicle compatibility. Make/model filters are independent of the garage filter. Unknown query params are rejected with 400.',
  })
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
