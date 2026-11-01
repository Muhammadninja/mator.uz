import {
  OrderActorType,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';

/**
 * Prisma `select` for an admin list row — only the columns the row projection
 * needs. `payments` pulls the most recent payment for method/status; `_count`
 * yields the item count without loading the items themselves.
 */
export const ADMIN_ORDER_LIST_SELECT = {
  id: true,
  status: true,
  totalUzs: true,
  paymentType: true,
  refundSettledAt: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      displayName: true,
      firstName: true,
      lastName: true,
      phoneE164: true,
    },
  },
  payments: {
    select: { provider: true, status: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
  _count: { select: { items: true } },
} satisfies Prisma.OrderSelect;

/**
 * Prisma `select` for the admin details view — customer, shipping, item
 * snapshots, latest payment, and the full status history (ascending).
 */
export const ADMIN_ORDER_DETAIL_SELECT = {
  id: true,
  status: true,
  totalUzs: true,
  deliveryUzs: true,
  paymentType: true,
  refundSettledAt: true,
  deliveryMethod: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      displayName: true,
      firstName: true,
      lastName: true,
      phoneE164: true,
      email: true,
    },
  },
  deliveryAddress: {
    select: {
      regionCode: true,
      district: true,
      street: true,
      fullText: true,
      lat: true,
      lng: true,
    },
  },
  items: {
    select: {
      id: true,
      partId: true,
      title: true,
      quantity: true,
      priceUzs: true,
      lineTotalUzs: true,
    },
    orderBy: { id: 'asc' },
  },
  payments: {
    select: { provider: true, status: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
  statusHistory: {
    select: {
      id: true,
      status: true,
      note: true,
      actorType: true,
      actorId: true,
      actorName: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.OrderSelect;

export type AdminOrderListRow = Prisma.OrderGetPayload<{
  select: typeof ADMIN_ORDER_LIST_SELECT;
}>;
export type AdminOrderDetail = Prisma.OrderGetPayload<{
  select: typeof ADMIN_ORDER_DETAIL_SELECT;
}>;

type CustomerFields = {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
};

/** Best available human name: display name, else first+last, else null. */
function customerName(u: CustomerFields): string | null {
  return (
    u.displayName?.trim() ||
    [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
    null
  );
}

/**
 * Method/status from the most recent payment. An order with none falls back to
 * the method the customer chose at checkout: a cash or terminal order never gets
 * a payment row, and those are exactly the ones an operator has to act on.
 */
function paymentSummary(
  payments: { provider: string; status: string }[],
  chosen: string | null | undefined,
): {
  method: string | null;
  status: string | null;
} {
  const latest = payments[0];
  return {
    method: latest
      ? latest.provider.toLowerCase()
      : (chosen?.toLowerCase() ?? null),
    status: latest ? latest.status.toLowerCase() : null,
  };
}

/**
 * A cancelled order whose payment still reads paid: the money was taken and nothing
 * has given it back yet. The provider's refund callback moves both to REFUNDED, so
 * this clears itself the moment a refund really happens. A refund made outside the
 * provider sends no callback, so the refund registry clears it too, once its entries
 * account for everything the order took. Row-level twin of {@link REFUND_DUE_WHERE}.
 */
function isRefundDue(
  o: { status: OrderStatus; refundSettledAt?: Date | null },
  payment: { status: string | null },
): boolean {
  return (
    o.status === OrderStatus.CANCELLED &&
    payment.status === PaymentStatus.PAID.toLowerCase() &&
    !o.refundSettledAt
  );
}

export const REFUND_DUE_WHERE = {
  status: OrderStatus.CANCELLED,
  refundSettledAt: null,
  payments: { some: { status: PaymentStatus.PAID } },
} satisfies Prisma.OrderWhereInput;

export function presentAdminOrderRow(
  o: AdminOrderListRow,
  slaOverdue = false,
  operatorWarning = false,
) {
  const payment = paymentSummary(o.payments, o.paymentType);
  return {
    id: o.id,
    status: o.status.toLowerCase(),
    totalAmount: Number(o.totalUzs),
    paymentMethod: payment.method,
    paymentStatus: payment.status,
    slaOverdue,
    operatorWarning,
    refundDue: isRefundDue(o, payment),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    customer: {
      id: o.user.id,
      name: customerName(o.user),
      phone: o.user.phoneE164,
    },
    itemsCount: o._count.items,
  };
}

/**
 * Map the delivery Address onto the shipping contract. Returns null when the
 * order has no address (e.g. pickup). There is no dedicated landmark column, so
 * `landmark` is null; `location` is null unless both coordinates are present.
 */
function presentShippingAddress(a: AdminOrderDetail['deliveryAddress']) {
  if (!a) return null;
  const location =
    a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : null;
  return {
    city: a.regionCode ?? null,
    district: a.district ?? null,
    addressLine: a.fullText ?? null,
    landmark: null,
    location,
  };
}

function presentHistoryRow(h: AdminOrderDetail['statusHistory'][number]) {
  return {
    id: h.id,
    status: h.status.toLowerCase(),
    note: h.note ?? null,
    actor: {
      type: h.actorType,
      id: h.actorId ?? null,
      name:
        h.actorName ??
        (h.actorType === OrderActorType.SYSTEM ? 'System' : null),
    },
    createdAt: h.createdAt.toISOString(),
  };
}

export function presentAdminOrderDetail(
  o: AdminOrderDetail,
  slaOverdue = false,
  operatorWarning = false,
) {
  const payment = paymentSummary(o.payments, o.paymentType);

  // Every status change now writes a history row (creation included) via the
  // OrderStatusService chokepoint, so the stored rows ARE the authoritative,
  // chronological history. The synthesized creation entry below is only a
  // fallback for legacy orders created before the history table existed, so
  // their timeline is never empty.
  const statusHistory =
    o.statusHistory.length > 0
      ? o.statusHistory.map(presentHistoryRow)
      : [
          {
            id: `sys_created_${o.id}`,
            status: OrderStatus.PENDING_PAYMENT.toLowerCase(),
            note: 'Order created',
            actor: {
              type: OrderActorType.SYSTEM,
              id: null as string | null,
              name: 'System',
            },
            createdAt: o.createdAt.toISOString(),
          },
        ];

  return {
    id: o.id,
    status: o.status.toLowerCase(),
    totalAmount: Number(o.totalUzs),
    deliveryFee: Number(o.deliveryUzs),
    deliveryMethod: o.deliveryMethod?.toLowerCase() ?? null,
    paymentMethod: payment.method,
    paymentStatus: payment.status,
    slaOverdue,
    operatorWarning,
    refundDue: isRefundDue(o, payment),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    customer: {
      id: o.user.id,
      name: customerName(o.user),
      phone: o.user.phoneE164,
      email: o.user.email,
    },
    shippingAddress: presentShippingAddress(o.deliveryAddress),
    items: o.items.map((it) => ({
      id: it.id,
      productId: it.partId,
      title: it.title,
      sku: null,
      quantity: it.quantity,
      price: Number(it.priceUzs),
      totalPrice: Number(it.lineTotalUzs),
      imageUrl: null,
    })),
    statusHistory,
  };
}
