import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Sort fields the admin orders list accepts (mapped to real columns in the service). */
export const ADMIN_ORDER_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'totalAmount',
  'status',
] as const;
export type AdminOrderSortField = (typeof ADMIN_ORDER_SORT_FIELDS)[number];

/**
 * Query params for GET /v1/admin/orders. Offset pagination (page/limit),
 * comma-separated status filter, free-text search, and a whitelisted sort.
 *
 * `sortBy`/`order` are validated with `@IsIn` so an unknown value is rejected
 * with 400 by the global ValidationPipe — client input never reaches Prisma's
 * `orderBy` unchecked. `status` is a raw string here (comma-separated); the
 * service parses and validates each token against the real OrderStatus vocab.
 */
export class ListAdminOrdersQueryDto {
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
  @MaxLength(200)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @IsIn(ADMIN_ORDER_SORT_FIELDS, {
    message: 'sortBy is not a supported sort field',
  })
  sortBy?: AdminOrderSortField;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'], { message: 'order must be asc or desc' })
  order?: 'asc' | 'desc';

  /** One customer's orders, for their profile page. */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  /** Cash and terminal orders waiting for an operator past the SLA. */
  @IsOptional()
  @IsIn(['true', 'false'])
  slaOverdue?: 'true' | 'false';

  /** Cash and terminal orders waiting so long that the console warns about them. */
  @IsOptional()
  @IsIn(['true', 'false'])
  operatorWarning?: 'true' | 'false';

  /** Cancelled orders whose payment still reads paid: a refund may be owed. */
  @IsOptional()
  @IsIn(['true', 'false'])
  refundDue?: 'true' | 'false';
}

/** Query params for GET /v1/admin/orders/board. */
export class AdminOrdersBoardQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  perStatus?: number;
}
