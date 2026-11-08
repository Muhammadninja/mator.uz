import { OrderStatus } from '@prisma/client';

/**
 * THE order state machine — the single source of truth for which status may
 * follow which. Mapped onto the existing Prisma `OrderStatus` enum (not the
 * contract's `confirmed/packed/out_for_delivery` vocabulary, which has no schema
 * column): `PENDING_PAYMENT → PAID → PROCESSING → SHIPPED → DELIVERED`, with
 * `CANCELLED`/`REFUNDED`/`EXPIRED` terminal.
 *
 * Used by the operator status write (illegal jumps → 400) and by payment
 * settlement, which derives the statuses a payment may settle FROM
 * ({@link PAYABLE_ORDER_STATUSES}) instead of keeping its own list.
 *
 * (A provider-initiated REFUND is deliberately not routed through this table:
 * the money has already moved at the provider, so the order must follow into
 * REFUNDED even from CANCELLED — see PROVIDER_REFUNDABLE_ORDER_STATUSES.)
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  [OrderStatus.PENDING_PAYMENT]: [
    OrderStatus.PAID,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
  ],
  [OrderStatus.PAID]: [
    OrderStatus.PROCESSING,
    OrderStatus.CANCELLED,
    OrderStatus.REFUNDED,
  ],
  [OrderStatus.PROCESSING]: [
    OrderStatus.SHIPPED,
    OrderStatus.CANCELLED,
    OrderStatus.REFUNDED,
  ],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.EXPIRED]: [],
};

/**
 * Statuses the system alone may set. EXPIRED is the sweeper's verdict, and
 * REFUNDED records money the provider returned (SettlementService.markCancelled):
 * an operator setting it by hand would claim a refund that never happened and
 * leave the payment PAID. They are in the table above for the derived lists, not
 * as operator actions.
 */
export const SYSTEM_ONLY_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.EXPIRED,
  OrderStatus.REFUNDED,
];

/** May an order move from `from` to `to`? (Staying put is not a transition.) */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return from !== to && ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * What an operator may do with this order. A cash or terminal order that records
 * collection is paid when the money is received, usually at the door, so it goes to
 * work from PENDING_PAYMENT and never takes PAID by hand: PAID always means paid, and
 * for these orders the money is OfflineCollection, apart from the status. The table
 * above is left alone for every other order and for payment settlement.
 */
export function canOperatorTransition(
  from: OrderStatus,
  to: OrderStatus,
  order: { offlineCollectionRequired: boolean },
): boolean {
  if (order.offlineCollectionRequired) {
    if (to === OrderStatus.PAID) return false;
    if (from === OrderStatus.PENDING_PAYMENT && to === OrderStatus.PROCESSING) {
      return true;
    }
  }
  return canTransition(from, to);
}

/**
 * Statuses from which a successful payment may settle an order to PAID —
 * derived from the state machine, so it can never drift from it. Today this is
 * exactly `[PENDING_PAYMENT]`: a CANCELLED, EXPIRED, REFUNDED or already-PAID
 * order is never (re)settled by a payment provider.
 */
export const PAYABLE_ORDER_STATUSES: readonly OrderStatus[] = (
  Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[]
).filter((s) => canTransition(s, OrderStatus.PAID));

export function isPayableOrderStatus(status: OrderStatus): boolean {
  return PAYABLE_ORDER_STATUSES.includes(status);
}

/**
 * Statuses from which a provider's reversal of a performed payment may move an order
 * to REFUNDED: everything but goods already handed over, and an order already there.
 * Used as the guard of one conditional UPDATE, so an order shipped between the
 * provider's request and this write cannot be refunded behind the courier's back.
 */
export const PROVIDER_REFUNDABLE_ORDER_STATUSES: readonly OrderStatus[] = (
  Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[]
).filter(
  (s) =>
    s !== OrderStatus.SHIPPED &&
    s !== OrderStatus.DELIVERED &&
    s !== OrderStatus.REFUNDED,
);

/**
 * Orders still IN PROGRESS — every status the state machine can still move on
 * from (a terminal status has no outgoing transition). Today exactly
 * `PENDING_PAYMENT`, `PAID`, `PROCESSING` and `SHIPPED`; `DELIVERED`,
 * `CANCELLED`, `REFUNDED` and `EXPIRED` are finished. Derived from the table,
 * so a status added with outgoing transitions is active automatically.
 * Account deletion is refused while an order is in one of these.
 */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = (
  Object.keys(ALLOWED_TRANSITIONS) as OrderStatus[]
).filter((s) => ALLOWED_TRANSITIONS[s].length > 0);
