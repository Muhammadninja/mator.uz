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
}
