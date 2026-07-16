import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

/** Equality filters — mirror the frontend TopFeaturedFilterKey set. */
export class TopFeaturedFiltersDto {
  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  condition?: string;
}

/**
 * Body for POST /v1/top-featured/list — mirrors the frontend
 * TopFeaturedListRequest ({ page, pageSize, filters, search?, sortBy? }).
 */
export class ListTopFeaturedDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsObject()
  filters?: TopFeaturedFiltersDto;

  @IsOptional()
  @IsString()
  search?: string | null;

  @IsOptional()
  @IsIn(['featured', 'newest', 'price_asc', 'price_desc'])
  sortBy?: 'featured' | 'newest' | 'price_asc' | 'price_desc';
}
