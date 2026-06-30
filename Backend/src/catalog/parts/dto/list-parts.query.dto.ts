import { IsString, IsOptional, IsInt, IsIn, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListPartsQueryDto {
  @IsOptional()
  @IsString()
  vehicle_id?: string;

  @IsOptional()
  @IsString()
  category_id?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  min_price_uzs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  max_price_uzs?: number;

  // comma-separated brand ids (e.g. "brand_gates,brand_dayco")
  @IsOptional()
  @IsString()
  brand_ids?: string;

  @IsOptional()
  @IsIn(['new', 'used', 'refurbished'])
  condition?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  in_stock_only?: string;

  @IsOptional()
  @IsString()
  delivery_region_code?: string;

  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'relevance'])
  sort_by?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page_size?: number;
}
