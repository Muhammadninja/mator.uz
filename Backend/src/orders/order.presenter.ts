import { Prisma } from '@prisma/client';

export const ORDER_INCLUDE = { items: { orderBy: { id: 'asc' } } } satisfies Prisma.OrderInclude;
export type OrderWithItems = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

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
    created_at: order.createdAt.toISOString(),
    updated_at: order.updatedAt.toISOString(),
  };
}
