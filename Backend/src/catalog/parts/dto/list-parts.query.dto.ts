import { IsString, IsOptional, IsInt, IsIn, Min, Max } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { OilType, ProductKind } from '@prisma/client';

// Region-of-origin values accepted on the wire (lowercase market names), mapped
// to the PartOriginRegion enum in the service.
export const PART_REGION_VALUES = [
  'china',
  'europe',
  'russia',
  'korea',
  'usa',
  'japan',
] as const;

// Listing kinds accepted on the wire, lowercased to match the rest of this
// contract (region/sort are lowercase too). Mapped to the ProductKind enum in
// the service.
export const PART_KIND_VALUES = ['spare_part', 'motor_oil'] as const;
export const KIND_BY_WIRE: Record<string, ProductKind> = {
  spare_part: ProductKind.SPARE_PART,
  motor_oil: ProductKind.MOTOR_OIL,
};

// Oil types accepted on the wire. Same lowercase convention.
export const OIL_TYPE_VALUES = [
  'synthetic',
  'semi_synthetic',
  'mineral',
] as const;
export const OIL_TYPE_BY_WIRE: Record<string, OilType> = {
  synthetic: OilType.SYNTHETIC,
  semi_synthetic: OilType.SEMI_SYNTHETIC,
  mineral: OilType.MINERAL,
};

/**
 * Normalize a repeated-or-single query param into a lowercase string[] limited to
 * `allowed`. Unknown values are DROPPED rather than rejected: the client controls
 * these sets, and a stale value from an old build must not 400 the whole listing
 * (the same rule the `region` filter has always followed).
 */
const toAllowedList = (allowed: readonly string[]) =>
  Transform(({ value }: { value: unknown }) => {
    const arr = Array.isArray(value) ? value : [value];
    return arr
      .map((v) => String(v).trim().toLowerCase())
      .filter((v) => allowed.includes(v));
  });

/**
 * Query contract for GET /v1/catalog/parts. Field names match the frontend
 * contract (backend.json / PartsCatalogueScreen). The global ValidationPipe runs
 * with forbidNonWhitelisted, so any unknown query param is rejected with 400 —
 * exactly the "strictly rejects unknown query params" behavior the client expects.
 */
export class ListPartsQueryDto {
  @ApiPropertyOptional({
    description:
      'Garage vehicle id — restricts results to parts compatible with that vehicle.',
  })
  @IsOptional()
  @IsString()
  vehicle_id?: string;

  @ApiPropertyOptional({
    description:
      'Main category enum value (e.g. BRAKES) or a category id/slug.',
  })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({
    description: 'Vehicle-specific category enum value (e.g. BRAKE_SYSTEM).',
  })
  @IsOptional()
  @IsString()
  vehicle_category?: string;

  @ApiPropertyOptional({ description: 'Free-text search over part title.' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description:
      'Vehicle make — canonical name (Chevrolet) or make slug (make_chevrolet).',
  })
  @IsOptional()
  @IsString()
  make?: string;

  @ApiPropertyOptional({
    description:
      'Vehicle model — canonical name (Cobalt) or model slug (model_chevrolet_cobalt).',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description:
      'Part manufacturer brand id (e.g. brand_gates); comma-separated for multiple.',
  })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: PART_REGION_VALUES,
    description:
      'Market(s) of origin. Repeated query param: region=china&region=korea.',
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

  // ── Listing kind + kind-specific filters ────────────────────────────────────
  @ApiPropertyOptional({
    isArray: true,
    enum: PART_KIND_VALUES,
    description:
      'Listing kind(s). Repeated query param: kind=motor_oil. Omitted → every kind is returned, which is the historical behaviour.',
  })
  @IsOptional()
  @toAllowedList(PART_KIND_VALUES)
  @IsIn(PART_KIND_VALUES, { each: true })
  kind?: string[];

  @ApiPropertyOptional({
    isArray: true,
    description:
      'Motor-oil SAE grade(s), e.g. viscosity=5W-30&viscosity=0W-20. Matched case-insensitively and exactly (never as a substring, so 5W-30 does not match 15W-30).',
    example: '5W-30',
  })
  @IsOptional()
  // Free-form rather than an enum: sellers may enter a grade outside the wizard's
  // preset list (0W-16, 20W-50, …) via its "Другое" branch, so the accepted set is
  // open. Blanks are dropped; the value is normalized in the service.
  @Transform(({ value }) => {
    const arr = Array.isArray(value) ? value : [value];
    return arr.map((v) => String(v).trim()).filter(Boolean);
  })
  @IsString({ each: true })
  viscosity?: string[];

  @ApiPropertyOptional({
    isArray: true,
    enum: OIL_TYPE_VALUES,
    description:
      'Motor-oil base composition. Repeated: oil_type=synthetic&oil_type=mineral.',
  })
  @IsOptional()
  @toAllowedList(OIL_TYPE_VALUES)
  @IsIn(OIL_TYPE_VALUES, { each: true })
  oil_type?: string[];

  @ApiPropertyOptional({
    isArray: true,
    description:
      'Motor-oil package volume(s) in MILLILITRES — the stored unit, so 4 л is volume_ml=4000. Repeated: volume_ml=1000&volume_ml=4000.',
    example: 4000,
  })
  @IsOptional()
  @Transform(({ value }) => {
    const arr = Array.isArray(value) ? value : [value];
    return arr
      .map((v) => Number(String(v).trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  })
  @IsInt({ each: true })
  volume_ml?: number[];

  @ApiPropertyOptional({
    description: 'Minimum motor-oil volume in millilitres (inclusive).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  volume_ml_min?: number;

  @ApiPropertyOptional({
    description: 'Maximum motor-oil volume in millilitres (inclusive).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  volume_ml_max?: number;

  @ApiPropertyOptional({
    description: 'Restrict to GM-family brands (Chevrolet/Ravon/Daewoo).',
  })
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

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number;
}
