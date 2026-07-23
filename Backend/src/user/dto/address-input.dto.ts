import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Inline address payload accepted by PATCH /v1/me. Upserts the caller's DEFAULT
 * address in the existing Address table (single source of truth) via
 * AddressesService — it does NOT introduce a new address store.
 *
 * `full_text` is required (the schema's single NOT-NULL address column); the
 * rest are optional and fit the Uzbekistan marketplace (region_code like
 * "UZ-TK", district, street, optional geo). Field names/limits match
 * CreateAddressDto so validation stays consistent across the address endpoints.
 */
export class AddressInputDto {
  @ApiProperty({ example: 'Amir Temur ko‘chasi 12, Toshkent', description: 'Required — free-text address.' })
  @IsString()
  @MaxLength(500)
  full_text: string;

  @ApiPropertyOptional({ example: 'Home' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({
    example: 'UZ-TK',
    description: 'Region code (e.g. UZ-TK for Tashkent).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  region_code?: string;

  @ApiPropertyOptional({ example: 'Yunusobod' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @ApiPropertyOptional({ example: 'Amir Temur 12' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  street?: string;

  @ApiPropertyOptional({ example: 41.31 })
  @IsOptional()
  @IsNumber()
  lat?: number;

  @ApiPropertyOptional({ example: 69.28 })
  @IsOptional()
  @IsNumber()
  lng?: number;
}
