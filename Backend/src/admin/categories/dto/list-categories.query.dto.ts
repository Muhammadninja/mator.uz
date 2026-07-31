import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Query of GET /v1/admin/categories — the FLAT listing (the nested forest is
 * served by GET /v1/admin/categories/tree).
 *
 * All filters are optional and combine with AND. `parentId=null` (the literal
 * string) selects ROOT categories, which is distinct from omitting the filter
 * entirely (every category, any depth).
 *
 * The global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true`, so this class IS the accepted-field whitelist.
 */
export class ListCategoriesQueryDto {
  @ApiPropertyOptional({
    description:
      'Filter by parent. Pass the literal "null" for root categories only; ' +
      'omit for no parent filter.',
    example: 'brake-system',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parentId?: string;

  @ApiPropertyOptional({
    description:
      'Filter by depth: 0 = vehicle category, 1 = main, 2 = subcategory.',
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  level?: number;

  @ApiPropertyOptional({
    description: 'Filter by active flag. Omit to return both.',
    example: true,
  })
  @IsOptional()
  // Query params arrive as strings; accept "true"/"false" as well as booleans.
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean;
}
