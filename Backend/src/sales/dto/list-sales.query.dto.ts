import { SaleScopeType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Sort fields the admin sales list accepts (mapped to real columns in the service). */
export const SALE_SORT_FIELDS = [
  'createdAt',
  'startAt',
  'endAt',
  'title',
  'priority',
  'discountValue',
] as const;
export type SaleSortField = (typeof SALE_SORT_FIELDS)[number];

/**
 * Lifecycle filter, computed from the window and the two flags rather than
 * stored on the row. `deleted` implies includeDeleted — asking for deleted sales
 * is asking to see them.
 */
export const SALE_STATUS_FILTERS = [
  'active',
  'scheduled',
  'expired',
  'inactive',
  'deleted',
] as const;
export type SaleStatusFilter = (typeof SALE_STATUS_FILTERS)[number];

/**
 * Query params for GET /v1/admin/sales. Offset pagination, a lifecycle filter,
 * a scope filter, free-text title search and a whitelisted sort — the same
 * shape as the dealers and orders consoles.
 *
 * `status`, `scopeType`, `sort` and `order` are validated with `@IsIn`/`@IsEnum`,
 * so client input never reaches Prisma's `where`/`orderBy` unchecked.
 */
export class ListSalesQueryDto {
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
  @IsIn(SALE_STATUS_FILTERS, {
    message:
      'status must be one of: active, scheduled, expired, inactive, deleted',
  })
  status?: SaleStatusFilter;

  @IsOptional()
  @IsEnum(SaleScopeType, {
    message:
      'scopeType must be one of: ALL_PRODUCTS, PRODUCTS, CATEGORIES, DEALERS',
  })
  scopeType?: SaleScopeType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  /**
   * Query strings are text, so this is validated as a boolean-ish STRING and
   * narrowed in the service. Declaring it `boolean` here would make `?isActive=false`
   * arrive as the truthy string "false" and invert the filter.
   */
  @IsOptional()
  @IsBooleanString({ message: 'isActive must be true or false' })
  isActive?: string;

  /**
   * Include soft-deleted sales. Off by default, so the console shows the live
   * campaign set; `true` turns the list into the audit view. Validated as a
   * boolean-ish STRING for the same reason as `isActive` above.
   */
  @IsOptional()
  @IsBooleanString({ message: 'includeDeleted must be true or false' })
  includeDeleted?: string;

  @IsOptional()
  @IsString()
  @IsIn(SALE_SORT_FIELDS, { message: 'sort is not a supported sort field' })
  sort?: SaleSortField;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'], { message: 'order must be asc or desc' })
  order?: 'asc' | 'desc';
}
