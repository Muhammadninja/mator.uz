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

/** Sort fields the admin dealers list accepts (mapped to real columns in the service). */
export const ADMIN_DEALER_SORT_FIELDS = [
  'joinedAt',
  'name',
  'gmvUzs',
  'orders',
  'skus',
] as const;
export type AdminDealerSortField = (typeof ADMIN_DEALER_SORT_FIELDS)[number];

/**
 * Dealer statuses as they appear ON THE WIRE — lowercase, like the order
 * console's `status`. Mapped onto the real DealerStatus enum in the service.
 */
export const ADMIN_DEALER_STATUSES = ['active', 'pending', 'suspended'] as const;
export type AdminDealerStatusFilter =
  (typeof ADMIN_DEALER_STATUSES)[number];

/**
 * Query params for GET /v1/admin/dealers. Offset pagination (page/limit), a
 * single status filter, free-text search, and a whitelisted sort.
 *
 * `status`, `sort` and `order` are validated with `@IsIn`, so an unknown value
 * is rejected with 400 by the global ValidationPipe — client input never reaches
 * Prisma's `where`/`orderBy` unchecked. Mirrors ListAdminOrdersQueryDto, except
 * that `status` is a single enum value here rather than a comma-separated list,
 * because a dealer has exactly one moderation state and the console filters on
 * one at a time.
 */
export class ListAdminDealersQueryDto {
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
  @IsIn(ADMIN_DEALER_STATUSES, {
    message: 'status must be one of: active, pending, suspended',
  })
  status?: AdminDealerStatusFilter;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @IsIn(ADMIN_DEALER_SORT_FIELDS, {
    message: 'sort is not a supported sort field',
  })
  sort?: AdminDealerSortField;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'], { message: 'order must be asc or desc' })
  order?: 'asc' | 'desc';
}
