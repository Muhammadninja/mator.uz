import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query contract for GET /v1/admin/categories (the flat, filterable list). All
 * filters are optional and AND-combined. The global ValidationPipe runs with
 * forbidNonWhitelisted, so any unknown param is rejected with 400.
 */
export class ListCategoriesQueryDto {
  @ApiPropertyOptional({
    description:
      'Parent filter. Pass the LITERAL string "null" to restrict to roots; any ' +
      'other value filters to that parent’s direct children. Omitted → no filter.',
    example: 'null',
  })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional({
    description: 'Depth filter — 0 = root, 1 = main, 2 = subcategory.',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  level?: number;

  @ApiPropertyOptional({
    description: 'Visibility filter. Accepts true/false (string or boolean).',
  })
  @IsOptional()
  // Accept the string forms "true"/"false" (query params are strings) as well as
  // real booleans, normalizing to a boolean before validation.
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean;
}
