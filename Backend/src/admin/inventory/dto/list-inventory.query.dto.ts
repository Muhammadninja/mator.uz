import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Stock-status filters the inventory list accepts. */
export const INVENTORY_STOCK_FILTERS = [
  'in_stock',
  'low_stock',
  'out_of_stock',
] as const;
export type InventoryStockFilter = (typeof INVENTORY_STOCK_FILTERS)[number];

/**
 * Query params for GET /v1/admin/inventory. Offset pagination (page/limit),
 * free-text search across SKU/OEM/name/cross numbers, and category / brand /
 * stock-status filters.
 *
 * `stock` is validated with `@IsIn`, so an unknown value is rejected with 400 by
 * the global ValidationPipe. Mirrors ListAdminBrandsQueryDto.
 */
export class ListInventoryQueryDto {
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
  @MaxLength(64)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  brandId?: string;

  @IsOptional()
  @IsString()
  @IsIn(INVENTORY_STOCK_FILTERS, {
    message: 'stock must be one of: in_stock, low_stock, out_of_stock',
  })
  stock?: InventoryStockFilter;
}
