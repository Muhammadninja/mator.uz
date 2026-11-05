import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body for POST /v1/addresses. An address needs `full_text`, or a point: a place with no
 * recognised street address is still somewhere a courier can go, so the service fills the
 * schema's NOT-NULL `full_text` column in that case. Everything is optional and matches the
 * existing address contract (snake_case) served by GET /v1/account/addresses.
 */
export class CreateAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  full_text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  region_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  street?: string;

  /** A readable hint for the courier. A map pin may have no other words at all. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  landmark?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
