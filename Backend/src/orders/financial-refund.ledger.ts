import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundMethod,
  RefundSource,
} from '@prisma/client';
import { IdPrefix, prefixedId } from '../common/ulid.util';

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
}

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
    tx.order.findUnique({
      where: { id: orderId },
      select: { totalUzs: true },
    }),
    tx.payment.findMany({
      where: { orderId, status: { in: MONEY_TAKEN } },
      select: { id: true, amountUzs: true, status: true },
      orderBy: { createdAt: 'desc' },
    }),
    tx.financialRefund.findMany({
      where: { orderId, voidedAt: null },
      select: { amountUzs: true, paymentId: true },
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

  return {
    received,
    refunded,
    remaining: left.gt(0) ? left : new Prisma.Decimal(0),
    paymentId:
      payments.find((p) => p.status === PaymentStatus.PAID)?.id ??
      payments[0]?.id ??
      null,
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
    await tx.financialRefund.create({
      data: {
        id: prefixedId(IdPrefix.FINANCIAL_REFUND),
        orderId: payment.orderId,
        paymentId: payment.id,
        amountUzs: unaccounted,
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
