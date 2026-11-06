import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundMethod,
  RefundSource,
} from '@prisma/client';
import { IdPrefix, prefixedId } from '../common/ulid.util';
import {
  ComponentPosition,
  OrderComponents,
  RefundBreakdown,
  SellerPosition,
  deriveBreakdown,
  readComponents,
} from './refund-breakdown';

/** Statuses of a payment that really took the customer's money. */
const MONEY_TAKEN: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.REFUNDED,
];

/** Where an order stands against the refund registry. */
export interface RefundPosition {
  /** What the order took in. Zero means there is nothing that could be returned. */
  received: Prisma.Decimal;
  /** What has gone back: the entries that are not voided, plus see below. */
  refunded: Prisma.Decimal;
  /** What could still be returned. Never below zero. */
  remaining: Prisma.Decimal;
  /** The payment the money came through, or null when no payment row exists. */
  paymentId: string | null;
  /** The service fee inside those figures: Mator's income, unless it goes back. */
  serviceFee: {
    /** What the order took as a fee. Zero when it took nothing. */
    charged: Prisma.Decimal;
    /** What has gone back to the buyer. */
    refunded: Prisma.Decimal;
    /** What stays with Mator so far, which is also what could still go back. */
    retained: Prisma.Decimal;
  };
  /** Delivery inside those figures: Mator's line, unless it goes back. */
  delivery: ComponentPosition;
  /** Each seller's goods, and Mator's commission on them. */
  sellers: SellerPosition[];
  /** Goods no seller is recorded for: an order placed before sellers were. */
  unattributed: ComponentPosition;
  /** The same, in the shape the registry's rules take (see refund-breakdown.ts). */
  components: OrderComponents;
}

/** What the registry reads of an entry, to tell what went back of each kind of money. */
const ENTRY_SELECT = {
  amountUzs: true,
  serviceFeeUzs: true,
  deliveryUzs: true,
  paymentId: true,
  allocations: {
    select: { sellerId: true, amountUzs: true, commissionUzs: true },
  },
} satisfies Prisma.FinancialRefundSelect;

/** What the registry reads of an order: its charges, and whose its lines are. */
const ORDER_SELECT = {
  totalUzs: true,
  serviceFeeUzs: true,
  deliveryUzs: true,
  items: {
    select: { sellerId: true, lineTotalUzs: true, commissionUzs: true },
  },
} satisfies Prisma.OrderSelect;

const sum = (amounts: Prisma.Decimal.Value[]) =>
  amounts.reduce<Prisma.Decimal>(
    (total, amount) => total.add(amount),
    new Prisma.Decimal(0),
  );

/**
 * The arithmetic of the registry. Callers pass their transaction and hold the
 * order's row lock, or two writers could both spend the same remaining amount.
 *
 * What an order took in comes from its settled payments. Without one, an order that
 * ever reached PAID took its total: a cash or terminal order never has a payment
 * row, and neither does an online order confirmed by hand.
 *
 * A payment the provider reversed has gone back in full, whatever the registry says.
 * Reversals from before the registry have no entry, and without this they would read
 * as money still to return, inviting a manager to record it a second time.
 */
export async function readRefundPosition(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<RefundPosition> {
  const [order, payments, entries, timesPaid] = await Promise.all([
    tx.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT }),
    tx.payment.findMany({
      where: { orderId, status: { in: MONEY_TAKEN } },
      select: { id: true, amountUzs: true, status: true },
      orderBy: { createdAt: 'desc' },
    }),
    tx.financialRefund.findMany({
      where: { orderId, voidedAt: null },
      select: ENTRY_SELECT,
    }),
    tx.orderStatusHistory.count({
      where: { orderId, status: OrderStatus.PAID },
    }),
  ]);

  let received = sum(payments.map((p) => p.amountUzs));
  if (received.lte(0) && timesPaid > 0 && order) {
    received = new Prisma.Decimal(order.totalUzs);
  }

  const reversedWithoutEntry = payments
    .filter((p) => p.status === PaymentStatus.REFUNDED)
    .map((p) => {
      const onThisPayment = entries.filter((e) => e.paymentId === p.id);
      const gap = new Prisma.Decimal(p.amountUzs).sub(
        sum(onThisPayment.map((e) => e.amountUzs)),
      );
      return gap.gt(0) ? gap : new Prisma.Decimal(0);
    });
  const refunded = sum([
    ...entries.map((e) => e.amountUzs),
    ...reversedWithoutEntry,
  ]);
  const left = received.sub(refunded);
  const remaining = left.gt(0) ? left : new Prisma.Decimal(0);

  // The fee, delivery and each seller's goods stay where they are unless a refund says
  // otherwise, and a partial refund recomputes none of them: they were fixed when the order
  // was placed. Once everything has gone back, so has every part of it, by arithmetic, even
  // for a reversal with no entry to say so.
  const components = readComponents({
    order: order ? toComponentOrder(order) : null,
    entries: entries.map(toComponentEntry),
    tookMoney: received.gt(0),
    everythingBack: received.gt(0) && remaining.lte(0),
  });

  return {
    received,
    refunded,
    remaining,
    paymentId:
      payments.find((p) => p.status === PaymentStatus.PAID)?.id ??
      payments[0]?.id ??
      null,
    serviceFee: {
      charged: components.serviceFee.charged,
      refunded: components.serviceFee.refunded,
      retained: components.serviceFee.remaining,
    },
    delivery: components.delivery,
    sellers: components.sellers,
    unattributed: components.unattributed,
    components,
  };
}

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;
type EntryRow = Prisma.FinancialRefundGetPayload<{
  select: typeof ENTRY_SELECT;
}>;

/** A row as read, or as a test double gives it with fewer columns. */
function toComponentOrder(order: Partial<OrderRow>) {
  return {
    totalUzs: order.totalUzs ?? 0,
    serviceFeeUzs: order.serviceFeeUzs ?? 0,
    deliveryUzs: order.deliveryUzs ?? 0,
    items: order.items ?? [],
  };
}

function toComponentEntry(entry: Partial<EntryRow>) {
  return {
    amountUzs: entry.amountUzs ?? 0,
    serviceFeeUzs: entry.serviceFeeUzs ?? 0,
    deliveryUzs: entry.deliveryUzs ?? 0,
    allocations: entry.allocations ?? [],
  };
}

/** The columns and allocation rows an entry with this breakdown is written with. */
export function breakdownData(breakdown: RefundBreakdown) {
  return {
    serviceFeeUzs: breakdown.serviceFeeUzs,
    deliveryUzs: breakdown.deliveryUzs,
    ...(breakdown.allocations.length > 0
      ? {
          allocations: {
            create: breakdown.allocations.map((allocation) => ({
              id: prefixedId(IdPrefix.FINANCIAL_REFUND_ALLOCATION),
              sellerId: allocation.sellerId,
              amountUzs: allocation.amountUzs,
              commissionUzs: allocation.commissionUzs,
            })),
          },
        }
      : {}),
  };
}

/**
 * Bring orders.refund_settled_at in line with the entries, after any write to them.
 * Conditional, so an order already in the right state keeps its first timestamp and
 * its updated_at.
 */
export async function settleRefundPosition(
  tx: Prisma.TransactionClient,
  orderId: string,
  now: Date = new Date(),
): Promise<RefundPosition> {
  const position = await readRefundPosition(tx, orderId);
  const settled = position.received.gt(0) && position.remaining.lte(0);
  await tx.order.updateMany({
    where: { id: orderId, refundSettledAt: settled ? null : { not: null } },
    data: { refundSettledAt: settled ? now : null },
  });
  return position;
}

/**
 * The provider itself reversed a settled payment, so the money is back with the
 * customer. Runs inside the callback's transaction, once per payment: the caller's
 * conditional claim sees to that.
 *
 * An entry a manager already wrote for a refund made in the provider's cabinet is
 * this same refund arriving from the other side, so it is confirmed rather than
 * counted twice. Only what no entry accounts for gets a new one.
 */
export async function recordProviderRefund(
  tx: Prisma.TransactionClient,
  payment: {
    id: string;
    orderId: string;
    amountUzs: Prisma.Decimal.Value;
    providerTransactionId: string | null;
  },
  now: Date = new Date(),
): Promise<void> {
  const active = await tx.financialRefund.findMany({
    where: { paymentId: payment.id, voidedAt: null },
    select: { id: true, amountUzs: true, method: true },
  });

  const byProvider = active
    .filter((entry) => entry.method === RefundMethod.PROVIDER)
    .map((entry) => entry.id);
  if (byProvider.length > 0) {
    await tx.financialRefund.updateMany({
      where: { id: { in: byProvider } },
      data: { providerConfirmedAt: now },
    });
  }

  const unaccounted = new Prisma.Decimal(payment.amountUzs).sub(
    sum(active.map((entry) => entry.amountUzs)),
  );
  if (unaccounted.gt(0)) {
    // A provider reversal is of the whole payment, so it takes whatever of each kind of money
    // no entry has given back yet: each seller's goods, delivery and the fee. Read from the
    // entries alone, since this payment already reads as reversed.
    const breakdown = deriveBreakdown(
      await componentsFromEntries(tx, payment.orderId),
      unaccounted,
    );
    await tx.financialRefund.create({
      data: {
        id: prefixedId(IdPrefix.FINANCIAL_REFUND),
        orderId: payment.orderId,
        paymentId: payment.id,
        amountUzs: unaccounted,
        ...breakdownData(breakdown),
        method: RefundMethod.PROVIDER,
        source: RefundSource.PROVIDER_CALLBACK,
        reference: payment.providerTransactionId ?? payment.id,
        reason: 'Refunded via payment provider',
        refundedAt: now,
        providerConfirmedAt: now,
      },
    });
  }

  await settleRefundPosition(tx, payment.orderId, now);
}

/** Each kind of money on an order as the entries alone leave it: what no entry gave back. */
async function componentsFromEntries(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<OrderComponents> {
  const [order, entries] = await Promise.all([
    tx.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT }),
    tx.financialRefund.findMany({
      where: { orderId, voidedAt: null },
      select: ENTRY_SELECT,
    }),
  ]);
  return readComponents({
    order: order ? toComponentOrder(order) : null,
    entries: entries.map(toComponentEntry),
    tookMoney: true,
    everythingBack: false,
  });
}
