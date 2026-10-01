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
 * REFUNDED even from CANCELLED — see SettlementService.markCancelled.)
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

/** May an order move from `from` to `to`? (Staying put is not a transition.) */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return from !== to && ALLOWED_TRANSITIONS[from].includes(to);
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
