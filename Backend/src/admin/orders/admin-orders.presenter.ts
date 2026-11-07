import {
  OrderActorType,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { settleOrder } from '../../orders/order-settlement';
import type { DeliveryDestination } from '../../shipping/delivery-quote.service';
import type { PickupPoint } from '../../shipping/pickup-points.service';

/** An order line under the dealer it is collected from. */
export interface AdminPickupItem {
  id: string;
  productId: string | null;
  title: string;
  quantity: number;
}

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
  subtotalUzs: true,
  discountUzs: true,
  serviceFeeUzs: true,
  deliveryUzs: true,
  paymentType: true,
  refundSettledAt: true,
  deliveryMethod: true,
  deliveryDestination: true,
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
      landmark: true,
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
      sellerId: true,
      providerId: true,
      // Which lines are goods, and the seller of an offer line: what a pickup order's
      // points are found from.
      offerId: true,
      serviceId: true,
      offerSellerTgId: true,
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

/** Where this order was confirmed to go, when it was priced for a point. */
function confirmedDestination(
  snapshot: Prisma.JsonValue,
): (DeliveryDestination & { lat: number; lng: number }) | null {
  const destination = snapshot as unknown as DeliveryDestination | null;
  return typeof destination?.lat === 'number' &&
    typeof destination.lng === 'number'
    ? destination
    : null;
}

/**
 * Map the delivery onto the shipping contract. Returns null when the order has no
 * address and no confirmed destination (e.g. pickup).
 *
 * For an order priced for a point everything here is the destination as confirmed, so what
 * the courier sees cannot change when the buyer edits or deletes the address afterwards.
 * `location` is the exact point the buyer chose. Only older orders read the address row,
 * since they have nothing else.
 */
function presentShippingAddress(
  a: AdminOrderDetail['deliveryAddress'],
  snapshot: AdminOrderDetail['deliveryDestination'],
) {
  const destination = confirmedDestination(snapshot);
  if (destination) {
    return {
      city: destination.regionCode ?? null,
      district: destination.district ?? null,
      addressLine: destination.fullText ?? null,
      landmark: destination.landmark ?? null,
      location: { lat: destination.lat, lng: destination.lng },
    };
  }
  if (!a) return null;
  return {
    city: a.regionCode ?? null,
    district: a.district ?? null,
    addressLine: a.fullText ?? null,
    landmark: a.landmark ?? null,
    location:
      a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : null,
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

/**
 * Whose money the order holds: what each seller is owed, and what is Mator's. The fee and
 * delivery are never in a seller's figure. Refunds are in the refund registry, and are not
 * taken off here, because it does not say which seller's goods went back.
 */
function presentSettlement(
  o: AdminOrderDetail,
  sellerNames: ReadonlyMap<string, string>,
) {
  const settlement = settleOrder(o);
  return {
    sellers: settlement.sellers.map((seller) => ({
      sellerId: seller.sellerId,
      name: sellerNames.get(seller.sellerId) ?? null,
      amount: seller.amountUzs,
    })),
    providers: settlement.providers.map((provider) => ({
      providerId: provider.providerId,
      amount: provider.amountUzs,
    })),
    unattributed: settlement.unattributedUzs,
    matorServiceFee: settlement.serviceFeeUzs,
    delivery: settlement.deliveryUzs,
    total: settlement.totalUzs,
  };
}

/**
 * @param pickupPoints where a pickup order's goods are collected, dealer by dealer; null for
 *   an order that is not collected (see AdminOrdersService.getOne).
 */
export function presentAdminOrderDetail(
  o: AdminOrderDetail,
  slaOverdue = false,
  operatorWarning = false,
  sellerNames: ReadonlyMap<string, string> = new Map(),
  pickupPoints: PickupPoint<AdminPickupItem>[] | null = null,
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
    itemsSubtotal: Number(o.subtotalUzs),
    discount: Number(o.discountUzs),
    serviceFee: Number(o.serviceFeeUzs),
    deliveryFee: Number(o.deliveryUzs),
    settlement: presentSettlement(o, sellerNames),
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
    shippingAddress: presentShippingAddress(
      o.deliveryAddress,
      o.deliveryDestination,
    ),
    // Each dealer the buyer collects from: its address and location as on record now, and
    // its own lines. The dealer of each line is the one the order recorded when placed.
    pickupPoints,
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
