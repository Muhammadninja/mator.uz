import { IsOptional, IsString } from 'class-validator';

/**
 * Body for `POST /v1/catalog/parts/:id/check-compatibility`.
 *
 * Either identifier resolves the buyer's vehicle context: `vehicleId` is the
 * primary path (a garage vehicle id); `vin` is the fallback when the app only
 * holds a raw VIN. At least one SHOULD be supplied — with neither, a
 * non-universal part can only answer UNCERTAIN.
 */
export class CheckCompatibilityDto {
  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsOptional()
  @IsString()
  vin?: string;
}
