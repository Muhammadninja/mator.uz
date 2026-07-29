import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Sort fields the admin brands list accepts (mapped to real columns / relation counts in the service). */
export const ADMIN_BRAND_SORT_FIELDS = [
  'name',
  'createdAt',
  'modelsCount',
] as const;
export type AdminBrandSortField = (typeof ADMIN_BRAND_SORT_FIELDS)[number];

/**
 * Query params for GET /v1/admin/brands. Offset pagination (page/limit),
 * free-text search on the brand name, and a whitelisted sort.
 *
 * `sort` and `order` are validated with `@IsIn`, so an unknown value is rejected
 * with 400 by the global ValidationPipe — client input never reaches Prisma's
 * `orderBy` unchecked. Mirrors ListAdminDealersQueryDto.
 */
export class ListAdminBrandsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @IsIn(ADMIN_BRAND_SORT_FIELDS, {
    message: 'sort is not a supported sort field',
  })
  sort?: AdminBrandSortField;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'], { message: 'order must be asc or desc' })
  order?: 'asc' | 'desc';
}
