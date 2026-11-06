import { Prisma } from '@prisma/client';
import { RefundPosition } from '../../orders/financial-refund.ledger';

export const ADMIN_REFUND_SELECT = {
  id: true,
  orderId: true,
  paymentId: true,
  amountUzs: true,
  serviceFeeUzs: true,
  method: true,
  source: true,
  reference: true,
  reason: true,
  refundedAt: true,
  providerConfirmedAt: true,
  createdByEmail: true,
  createdByName: true,
  voidedAt: true,
  voidedByEmail: true,
  voidReason: true,
  createdAt: true,
  order: {
    select: {
      status: true,
      user: {
        select: {
          displayName: true,
          firstName: true,
          lastName: true,
          phoneE164: true,
        },
      },
    },
  },
} satisfies Prisma.FinancialRefundSelect;

type RefundRow = Prisma.FinancialRefundGetPayload<{
  select: typeof ADMIN_REFUND_SELECT;
}>;

export function presentRefund(r: RefundRow) {
  const { user } = r.order;
  return {
    id: r.id,
    orderId: r.orderId,
    orderStatus: r.order.status.toLowerCase(),
    customerName:
      user.displayName?.trim() ||
      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
      null,
    customerPhone: user.phoneE164,
    amount: Number(r.amountUzs),
    serviceFee: Number(r.serviceFeeUzs),
    method: r.method.toLowerCase(),
    source: r.source.toLowerCase(),
    reference: r.reference,
    reason: r.reason,
    refundedAt: r.refundedAt.toISOString(),
    providerConfirmedAt: r.providerConfirmedAt?.toISOString() ?? null,
    createdBy: r.createdByName ?? r.createdByEmail,
    createdAt: r.createdAt.toISOString(),
    voidedAt: r.voidedAt?.toISOString() ?? null,
    voidedBy: r.voidedByEmail,
    voidReason: r.voidReason,
  };
}

export function presentPosition(p: RefundPosition) {
  return {
    received: Number(p.received),
    refunded: Number(p.refunded),
    remaining: Number(p.remaining),
    serviceFee: {
      charged: Number(p.serviceFee.charged),
      refunded: Number(p.serviceFee.refunded),
      retained: Number(p.serviceFee.retained),
    },
  };
}
