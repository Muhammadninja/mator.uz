import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ORDER_STATUSES } from './list-orders.query.dto';

/**
 * Body for PATCH /v1/orders/:id/status (operator status write).
 *
 * `status` is the lowercase contract value (same vocabulary as the
 * `GET /v1/orders` status filter, {@link ORDER_STATUSES}); the service maps it to
 * the Prisma `OrderStatus` enum and enforces the server-side state machine.
 * Cancelling needs a `note` or `reason`, and so does marking an online order paid
 * by hand; the service enforces both. Either is persisted onto the resulting
 * `OrderStatusHistory` row (note preferred, reason as fallback) and surfaced by the
 * admin order details endpoint — see order-status-write.md. `paymentReference` is
 * the document behind a manual payment confirmation (a Payme transaction id, a bank
 * or cabinet record), kept with it in the audit trail.
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

  @IsOptional()
  @IsString()
  @MaxLength(120)
  paymentReference?: string;
}
