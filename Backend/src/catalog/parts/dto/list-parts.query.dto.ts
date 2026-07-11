import { IsString, IsOptional, IsInt, IsIn, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

// Region-of-origin values accepted on the wire (lowercase market names), mapped
// to the PartOriginRegion enum in the service.
export const PART_REGION_VALUES = ['china', 'europe', 'russia', 'korea', 'usa'] as const;

/**
 * Query contract for GET /v1/catalog/parts. Field names match the frontend
 * contract (backend.json / PartsCatalogueScreen). The global ValidationPipe runs
 * with forbidNonWhitelisted, so any unknown query param is rejected with 400 —
 * exactly the "strictly rejects unknown query params" behavior the client expects.
 */
export class ListPartsQueryDto {
  @ApiPropertyOptional({ description: "Garage vehicle id — restricts results to parts compatible with that vehicle." })
  @IsOptional()
  @IsString()
  vehicle_id?: string;

  @ApiPropertyOptional({ description: 'Main category enum value (e.g. BRAKES) or a category id/slug.' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Vehicle-specific category enum value (e.g. BRAKE_SYSTEM).' })
  @IsOptional()
  @IsString()
  vehicle_category?: string;

  @ApiPropertyOptional({ description: 'Free-text search over part title.' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'Vehicle make — canonical name (Chevrolet) or make slug (make_chevrolet).' })
  @IsOptional()
  @IsString()
  make?: string;

  @ApiPropertyOptional({ description: 'Vehicle model — canonical name (Cobalt) or model slug (model_chevrolet_cobalt).' })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ description: 'Part manufacturer brand id (e.g. brand_gates); comma-separated for multiple.' })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: PART_REGION_VALUES,
    description: 'Market(s) of origin. Repeated query param: region=china&region=korea.',
  })
  @IsOptional()
  // Accept a single value or repeated params; normalize to a string[] of the
  // allowed lowercase market names (unknown values are dropped, not rejected —
  // the client controls the set and stale values must not 400 the whole list).
  @Transform(({ value }) => {
    const arr = Array.isArray(value) ? value : [value];
    return arr
      .map((v) => String(v).trim().toLowerCase())
      .filter((v) => (PART_REGION_VALUES as readonly string[]).includes(v));
  })
  @IsIn(PART_REGION_VALUES, { each: true })
  region?: string[];

  @ApiPropertyOptional({ description: 'Restrict to GM-family brands (Chevrolet/Ravon/Daewoo).' })
  @IsOptional()
  @IsIn(['true', 'false'])
  gm_only?: string;

  @ApiPropertyOptional({ description: 'OEM/original-quality parts only.' })
  @IsOptional()
  @IsIn(['true', 'false'])
  oem_only?: string;

  @ApiPropertyOptional({ description: 'Only parts currently in stock.' })
  @IsOptional()
  @IsIn(['true', 'false'])
  in_stock_only?: string;

  @ApiPropertyOptional({ enum: ['price_asc', 'price_desc', 'relevance'] })
  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'relevance'])
  sort?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number;
}
