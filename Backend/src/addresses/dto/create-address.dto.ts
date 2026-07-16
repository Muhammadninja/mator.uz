import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /v1/addresses. `full_text` is the only required field (the
 * schema's single NOT-NULL address content column). Everything else is optional
 * and matches the existing address contract (snake_case) served by
 * GET /v1/account/addresses.
 */
export class CreateAddressDto {
  @IsString()
  @MaxLength(500)
  full_text: string;

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

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
