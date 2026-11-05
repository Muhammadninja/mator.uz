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
 * Body for PATCH /v1/addresses/:id. Every field is optional — only the fields
 * present are updated (partial update). Setting is_default: true promotes this
 * address and demotes the others in one transaction.
 */
export class UpdateAddressDto {
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
