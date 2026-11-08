import {
  OrderStatus,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';

/**
 * Methods settled in person, on delivery. Such an order has no online payment
 * window to miss: it waits in PENDING_PAYMENT until an operator confirms it.
 */
export const OFFLINE_PAYMENT_TYPES: PaymentType[] = [
  PaymentType.CASH,
  PaymentType.TERMINAL,
];

/**
 * A cash or terminal order whose money has not been received. It can be in progress
 * or even delivered, and until an operator records the money it is not financially
 * paid, so no figure of money may count it.
 */
export const AWAITING_OFFLINE_MONEY: Prisma.OrderWhereInput = {
  offlineCollectionRequired: true,
  offlineCollection: { is: null },
  payments: {
    none: { status: { in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] } },
  },
};

/**
 * How long a cash or terminal order may wait for an operator. All are hours and
 * configurable, because the right values depend on when operators work.
 *
 *   • slaHours — past this the order is flagged in the console as overdue. It
 *     changes nothing about the order, so it defaults on.
 *   • operatorWarningHours — past this the console warns on every screen, not only
 *     in the queue. It changes nothing about the order either, so it defaults on.
 *     0 = off.
 *   • customerNoticeHours — past this the customer is told once that confirmation
 *     is running late. 0 = off, the default: it is a message to real customers.
 *   • timeoutHours — past this the order is expired and the customer told. 0 = off,
 *     the default: EXPIRED is terminal, so closing real orders is a decision to
 *     make deliberately. While off, an unattended order stays open, and it keeps
 *     blocking its customer's account deletion until an operator acts on it.
 */
export interface OfflineOrderPolicy {
  slaHours: number;
  operatorWarningHours: number;
  customerNoticeHours: number;
  timeoutHours: number;
}

const DEFAULT_SLA_HOURS = 2;
const DEFAULT_OPERATOR_WARNING_HOURS = 4;

function hours(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return raw !== undefined &&
    raw !== '' &&
    Number.isFinite(parsed) &&
    parsed >= 0
    ? parsed
    : fallback;
}

export function readOfflineOrderPolicy(
  get: (key: string) => string | undefined,
): OfflineOrderPolicy {
  return {
    slaHours: hours(get('OFFLINE_ORDER_SLA_HOURS'), DEFAULT_SLA_HOURS),
    operatorWarningHours: hours(
      get('OFFLINE_ORDER_OPERATOR_WARNING_HOURS'),
      DEFAULT_OPERATOR_WARNING_HOURS,
    ),
    customerNoticeHours: hours(get('OFFLINE_ORDER_CUSTOMER_NOTICE_HOURS'), 0),
    timeoutHours: hours(get('OFFLINE_ORDER_TIMEOUT_HOURS'), 0),
  };
}

const hoursAgo = (now: Date, h: number) =>
  new Date(now.getTime() - h * 60 * 60 * 1000);

/** Cash and terminal orders still waiting for an operator after `afterHours`. */
export function waitingOfflineOrders(
  now: Date,
  afterHours: number,
): Prisma.OrderWhereInput {
  return {
    status: OrderStatus.PENDING_PAYMENT,
    paymentType: { in: OFFLINE_PAYMENT_TYPES },
    createdAt: { lt: hoursAgo(now, afterHours) },
  };
}

type WaitingOrder = {
  status: OrderStatus;
  paymentType: PaymentType | null;
  createdAt: Date;
};

/** The row-level twin of {@link waitingOfflineOrders}. */
function isWaitingPast(order: WaitingOrder, now: Date, afterHours: number) {
  return (
    order.status === OrderStatus.PENDING_PAYMENT &&
    order.paymentType !== null &&
    OFFLINE_PAYMENT_TYPES.includes(order.paymentType) &&
    order.createdAt < hoursAgo(now, afterHours)
  );
}

export function isOverOfflineSla(
  order: WaitingOrder,
  now: Date,
  policy: OfflineOrderPolicy,
): boolean {
  return isWaitingPast(order, now, policy.slaHours);
}

export function isPastOperatorWarning(
  order: WaitingOrder,
  now: Date,
  policy: OfflineOrderPolicy,
): boolean {
  return (
    policy.operatorWarningHours > 0 &&
    isWaitingPast(order, now, policy.operatorWarningHours)
  );
}
