import { IsString, IsInt, IsOptional, IsBoolean, Matches, Min, MaxLength } from 'class-validator';

const HEX = /^#[0-9A-Fa-f]{6,8}$/;

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nickname?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  mileage_km?: number;

  @IsOptional()
  @IsBoolean()
  is_primary?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  registration_region_code?: string;

  @IsOptional()
  @Matches(HEX, { message: 'color_hex must be #RRGGBB or #RRGGBBAA' })
  color_hex?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  license_plate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  vin?: string;

  /**
   * The owner's pick among the vehicle's `generation.options` (a catalog model id),
   * or null to clear it. Only for a `choice_required` year; never with a trim.
   * Changes the picture only, never fitment.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  variant_model_id?: string | null;
}
