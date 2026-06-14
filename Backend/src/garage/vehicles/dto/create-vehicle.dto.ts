import {
  IsString,
  IsInt,
  IsOptional,
  IsBoolean,
  IsIn,
  Matches,
  Min,
  Max,
  MaxLength,
} from 'class-validator';

export const TRANSMISSIONS = ['manual', 'automatic', 'cvt', 'amt', 'robot'];
export const DRIVETRAINS = ['fwd', 'rwd', 'awd'];
export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'gas'];
const HEX = /^#[0-9A-Fa-f]{6,8}$/;

export class CreateVehicleDto {
  @IsString()
  make_id: string;

  @IsString()
  model_id: string;

  @IsInt()
  @Min(1950)
  @Max(2100)
  year: number;

  @IsOptional()
  @IsString()
  trim_id?: string;

  @IsOptional()
  @IsString()
  engine_id?: string;

  @IsOptional()
  @IsIn(TRANSMISSIONS)
  transmission?: string;

  @IsOptional()
  @IsIn(DRIVETRAINS)
  drivetrain?: string;

  @IsOptional()
  @Matches(HEX, { message: 'color_hex must be #RRGGBB or #RRGGBBAA' })
  color_hex?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  vin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  license_plate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  registration_region_code?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  mileage_km?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nickname?: string;

  @IsOptional()
  @IsBoolean()
  is_primary?: boolean;

  @IsOptional()
  @IsIn(FUEL_TYPES)
  fuel_type?: string;
}
