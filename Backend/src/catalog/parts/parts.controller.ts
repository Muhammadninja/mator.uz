import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { resolveRequestLang } from '../../common/app-lang.util';
import {
  OptionalJwtAuthGuard,
  OptionalJwtForVehicleGuard,
} from '../../auth/guards/optional-jwt-auth.guard';
import { PartsService } from './parts.service';
import { ListPartsQueryDto } from './dto/list-parts.query.dto';
import { CheckCompatibilityDto } from './dto/check-compatibility.dto';

@ApiTags('Catalog / Parts')
@Controller('v1/catalog/parts')
export class PartsController {
  constructor(private readonly parts: PartsService) {}

  // `vehicle_id` resolves only within the bearer's own garage (see
  // OptionalJwtForVehicleGuard); without it the route stays token-free.
  @Get()
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtForVehicleGuard)
  @ApiOperation({
    summary: 'Faceted parts catalog',
    description:
      'Server-side filtering by category (main or vehicle-specific), make, model, part brand, region of origin, GM-only, OEM-only, in-stock, and garage vehicle compatibility. Make/model filters are independent of the garage filter. Unknown query params are rejected with 400.\n\n' +
      "Garage filter: `vehicle_id` applies only to the authenticated caller's own (not deleted) garage vehicle; any other id — or no token — is treated like an unknown vehicle (no vehicle filter).\n\n" +
      'Listing kind: `kind=spare_part|motor_oil` (repeatable). Omitting it returns EVERY kind, which is the pre-ProductKind behaviour.\n\n' +
      'Motor oils additionally filter by `viscosity` (SAE grade, exact match, repeatable), `oil_type` (synthetic|semi_synthetic|mineral, repeatable) and volume — either exact values via `volume_ml` (repeatable, MILLILITRES: 4 л = 4000) or a range via `volume_ml_min`/`volume_ml_max`. Any of these implies `kind=motor_oil`. When the query concerns oils, `facets.motor_oil` returns the available viscosity/type/volume values with counts.',
  })
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description:
      'Display language for category labels: ru | uz | en (regional tags ' +
      'like ru-RU accepted). Defaults to ru.',
  })
  list(
    @Query() query: ListPartsQueryDto,
    @Request() req: { user?: { id: string } | null },
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.parts.list(
      query,
      resolveRequestLang(acceptLanguage),
      req.user?.id ?? null,
    );
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtForVehicleGuard)
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description:
      'Display language for category labels: ru | uz | en (regional tags ' +
      'like ru-RU accepted). Defaults to ru.',
  })
  detail(
    @Param('id') id: string,
    @Request() req: { user?: { id: string } | null },
    @Query('vehicle_id') vehicleId?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.parts.detail(
      id,
      vehicleId,
      resolveRequestLang(acceptLanguage),
      req.user?.id ?? null,
    );
  }

  @Get(':id/compatibility')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtForVehicleGuard)
  compatibility(
    @Param('id') id: string,
    @Query('vehicle_id') vehicleId: string,
    @Request() req: { user?: { id: string } | null },
  ) {
    return this.parts.compatibility(id, vehicleId, req.user?.id ?? null);
  }

  // Optional auth: the route stays public (universal parts answer for anyone),
  // but `vehicleId` / `vin` resolve ONLY within the bearer's own garage.
  @Post(':id/check-compatibility')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Check part↔vehicle compatibility (app contract)',
    description:
      'Resolves the buyer vehicle by `vehicleId` or `vin` — only among the ' +
      "authenticated caller's own garage vehicles — and returns the " +
      'app-facing status (EXACT_MATCH | UNIVERSAL | NOT_COMPATIBLE | UNCERTAIN) ' +
      'with a ready-to-render badge. Universal parts always answer UNIVERSAL; ' +
      'a curated Fitment Studio binding to the vehicle model answers ' +
      'EXACT_MATCH. Without a token no vehicle resolves (UNCERTAIN). ' +
      'The legacy `GET :id/compatibility` remains for backwards compatibility.',
  })
  checkCompatibility(
    @Param('id') id: string,
    @Body() body: CheckCompatibilityDto,
    @Request() req: { user?: { id: string } | null },
  ) {
    return this.parts.checkCompatibility(id, body, req.user?.id ?? null);
  }
}
