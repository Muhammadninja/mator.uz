import {
  Controller,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
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
      'Server-side filtering by category (main or vehicle-specific), make, model, part brand, region of origin, GM-only, OEM-only, in-stock, and garage vehicle compatibility. Make/model filters are independent of the garage filter. Unknown query params are rejected with 400.\n\n' +
      'Listing kind: `kind=spare_part|motor_oil` (repeatable). Omitting it returns EVERY kind, which is the pre-ProductKind behaviour.\n\n' +
      'Motor oils additionally filter by `viscosity` (SAE grade, exact match, repeatable), `oil_type` (synthetic|semi_synthetic|mineral, repeatable) and volume — either exact values via `volume_ml` (repeatable, MILLILITRES: 4 л = 4000) or a range via `volume_ml_min`/`volume_ml_max`. Any of these implies `kind=motor_oil`. When the query concerns oils, `facets.motor_oil` returns the available viscosity/type/volume values with counts.',
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
  compatibility(
    @Param('id') id: string,
    @Query('vehicle_id') vehicleId: string,
  ) {
    return this.parts.compatibility(id, vehicleId);
  }
}
