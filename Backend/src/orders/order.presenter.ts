import { OrderStatus, Prisma } from '@prisma/client';
import { ACTIVE_PROVIDER_STATE } from './order-status.service';

export const ORDER_INCLUDE = {
  items: { orderBy: { id: 'asc' } },
  // An open provider transaction suspends the payment window (see
  // OrderStatusService.expireOverdue); one row is enough to say so.
  payments: {
    where: { providerState: ACTIVE_PROVIDER_STATE },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.OrderInclude;
export type OrderWithItems = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

/**
 * True while the backend will NOT expire this unpaid order at `expires_at`: a
 * Payme transaction is open (Payme guarantees the buyer 12 hours to confirm it).
 * Mirrors the `payments: { none: … }` guard of the expiry sweep. Rows loaded
 * without the relation (tests, older callers) count as no open transaction.
 */
export function isExpirySuspended(
  order: Pick<OrderWithItems, 'status'> & { payments?: { id: string }[] },
): boolean {
  return order.status === OrderStatus.PENDING_PAYMENT && (order.payments?.length ?? 0) > 0;
}

export function presentOrder(order: OrderWithItems) {
  return {
    order_id: order.id,
    status: order.status.toLowerCase(),
    subtotal_uzs: Number(order.subtotalUzs),
    delivery_uzs: Number(order.deliveryUzs),
    service_fee_uzs: Number(order.serviceFeeUzs),
    discount_uzs: Number(order.discountUzs),
    total_uzs: Number(order.totalUzs),
    currency: order.currency,
    vehicle_id: order.vehicleId,
    delivery_address_id: order.deliveryAddressId,
    delivery_method: order.deliveryMethod ? order.deliveryMethod.toLowerCase() : null,
    // Lets the app tell an order waiting for online payment from a cash or terminal one,
    // which waits in the same status for an operator.
    payment_type: order.paymentType ? order.paymentType.toLowerCase() : null,
    items: order.items.map((it) => ({
      part_id: it.partId,
      service_id: it.serviceId,
      title: it.title,
      qty: it.quantity,
      price_uzs: Number(it.priceUzs),
      line_total_uzs: Number(it.lineTotalUzs),
      scheduled_at: it.scheduledAt ? it.scheduledAt.toISOString() : null,
    })),
    expires_at: order.expiresAt ? order.expiresAt.toISOString() : null,
    // The app counts down to `expires_at` only while this is false. It never
    // changes an order by itself: expiry is the backend's sweep.
    expiry_suspended: isExpirySuspended(order),
    created_at: order.createdAt.toISOString(),
    updated_at: order.updatedAt.toISOString(),
  };
}
