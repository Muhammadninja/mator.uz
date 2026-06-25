import { IsOptional, IsString, IsInt, IsIn, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'expired',
] as const;

/** Query params for GET /v1/orders (keyset pagination + optional status filter). */
export class ListOrdersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  @IsIn(ORDER_STATUSES, { message: 'status is not a valid order status' })
  status?: string;
}
