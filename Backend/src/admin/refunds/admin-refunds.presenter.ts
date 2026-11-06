import { PaymeFiscalReceiptType, Prisma, RefundMethod } from '@prisma/client';
import { FISCAL_STATUS_ACCEPTED } from '../../orders/webhooks/payme-fiscal-receipt.util';
import { RefundPosition } from '../../orders/financial-refund.ledger';
import { ComponentPosition } from '../../orders/refund-breakdown';

export const ADMIN_REFUND_SELECT = {
  id: true,
  orderId: true,
  paymentId: true,
  amountUzs: true,
  serviceFeeUzs: true,
  deliveryUzs: true,
  allocations: { select: { sellerId: true, amountUzs: true } },
  method: true,
  source: true,
  reference: true,
  fiscalReference: true,
  reason: true,
  refundedAt: true,
  providerConfirmedAt: true,
  createdByEmail: true,
  createdByName: true,
  voidedAt: true,
  voidedByEmail: true,
  voidReason: true,
  createdAt: true,
  // The payment's receipts: the sale receipt the refund goes back on, which a return receipt
  // from a cash register cites, and the cancellation receipt Payme registered, which covers a
  // refund only when Payme itself reversed that payment.
  payment: {
    select: {
      fiscalReceipts: {
        select: { type: true, receiptId: true, statusCode: true },
      },
    },
  },
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

type PaymentReceipt = {
  type: PaymeFiscalReceiptType;
  receiptId: string | null;
  statusCode: number | null;
};

/**
 * Whether a tax receipt for this refund is known to exist, and whose word that is. An entry in
 * the registry is never a receipt by itself:
 *   • a refund through Payme is covered by the cancellation receipt Payme registers when it
 *     reverses the whole payment: `awaiting_payme` until Payme has reversed it and reported that
 *     receipt, then `accepted` or `rejected`. Mator issues no return receipt of its own for it,
 *     or the return would be on record twice;
 *   • anything else (cash, a terminal, a transfer, and so any partial refund, which Payme cannot
 *     make) needs a return receipt from Mator's own cash register or the OFD:
 *     `stated_by_operator` when an operator recorded its number, which nothing here can check,
 *     and `missing` when nobody did.
 */
export function refundFiscalStatus(r: {
  method: RefundMethod;
  providerConfirmedAt: Date | null;
  fiscalReference: string | null;
  payment: { fiscalReceipts: PaymentReceipt[] } | null;
}): {
  status:
    | 'accepted'
    | 'rejected'
    | 'awaiting_payme'
    | 'stated_by_operator'
    | 'missing';
  receiptId: string | null;
} {
  if (r.method === RefundMethod.PROVIDER) {
    // Until Payme reverses the payment, whatever receipt the payment has is not this refund's.
    const receipt =
      r.providerConfirmedAt === null
        ? undefined
        : r.payment?.fiscalReceipts.find(
            (x) => x.type === PaymeFiscalReceiptType.CANCEL,
          );
    if (!receipt || receipt.statusCode === null) {
      return {
        status: 'awaiting_payme',
        receiptId: receipt?.receiptId ?? null,
      };
    }
    return {
      status:
        receipt.statusCode === FISCAL_STATUS_ACCEPTED ? 'accepted' : 'rejected',
      receiptId: receipt.receiptId,
    };
  }
  return r.fiscalReference
    ? { status: 'stated_by_operator', receiptId: r.fiscalReference }
    : { status: 'missing', receiptId: null };
}

/**
 * The sale receipt of the payment this refund goes back on, as Payme reported it: what a return
 * receipt has to cite. Null when the money did not come through Payme (cash or a terminal at
 * the counter, whose sale receipt is the register's own) or Payme has not reported it yet.
 */
export function saleReceiptOf(r: {
  payment: { fiscalReceipts: PaymentReceipt[] } | null;
}): { receiptId: string | null; statusCode: number | null } | null {
  const sale = r.payment?.fiscalReceipts.find(
    (x) => x.type === PaymeFiscalReceiptType.PERFORM,
  );
  return sale
    ? { receiptId: sale.receiptId, statusCode: sale.statusCode }
    : null;
}

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
    delivery: Number(r.deliveryUzs),
    allocations: r.allocations.map((a) => ({
      sellerId: a.sellerId,
      amount: Number(a.amountUzs),
    })),
    method: r.method.toLowerCase(),
    source: r.source.toLowerCase(),
    reference: r.reference,
    fiscalReference: r.fiscalReference,
    fiscalReceipt: refundFiscalStatus(r),
    saleReceipt: saleReceiptOf(r),
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

function presentComponent(c: ComponentPosition) {
  return {
    charged: Number(c.charged),
    refunded: Number(c.refunded),
    remaining: Number(c.remaining),
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
    delivery: presentComponent(p.delivery),
    sellers: p.sellers.map((s) => ({
      sellerId: s.sellerId,
      ...presentComponent(s),
    })),
    unattributed: presentComponent(p.unattributed),
  };
}
