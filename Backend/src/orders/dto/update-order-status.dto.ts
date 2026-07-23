import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ORDER_STATUSES } from './list-orders.query.dto';

/**
 * Body for PATCH /v1/orders/:id/status (operator status write).
 *
 * `status` is the lowercase contract value (same vocabulary as the
 * `GET /v1/orders` status filter, {@link ORDER_STATUSES}); the service maps it to
 * the Prisma `OrderStatus` enum and enforces the server-side state machine.
 * `reason` is required by convention when cancelling; `note` is a free-text
 * operator note. Both are accepted but not yet persisted (no history column) —
 * see order-status-write.md.
 */
export class UpdateOrderStatusDto {
  @IsString()
  @IsIn(ORDER_STATUSES, { message: 'status is not a valid order status' })
  status: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
