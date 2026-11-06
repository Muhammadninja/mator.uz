import {
  PaymentProvider,
  PaymentStatus,
  PaymeFiscalReceipt,
  PaymeFiscalReceiptType,
  Prisma,
} from '@prisma/client';

/** What a seller is owed, as the finance view shows it. Amounts in UZS. See seller-ledger.ts. */
export interface SellerBalance {
  sellerId: string;
  name: string | null;
  /** Their goods on orders that took the buyer's money, as charged. */
  soldUzs: number;
  /** What refunds gave back of their goods. */
  refundedUzs: number;
  /** Mator's commission on their goods, less what went back with refunds. */
  commissionUzs: number;
  /** Sold, less refunded, less commission: theirs in all. */
  earnedUzs: number;
  /** Of that, on orders they can be paid for: delivered, paid, nothing under way. */
  payableUzs: number;
  /** What Mator sent them. */
  paidOutUzs: number;
  /** Earned less paid out. Below zero when more was sent than they earned. */
  owedUzs: number;
  /** What a payout can take now: payable less paid out, never below zero. */
  payableNowUzs: number;
  /** What they owe Mator: paid out beyond what is payable, as after a refund of paid goods. */
  debtUzs: number;
}

export const PAYOUT_SELECT = {
  id: true,
  sellerId: true,
  amountUzs: true,
  method: true,
  reference: true,
  note: true,
  paidAt: true,
  createdByEmail: true,
  createdByName: true,
  voidedAt: true,
  voidedByEmail: true,
  voidReason: true,
  createdAt: true,
} satisfies Prisma.SellerPayoutSelect;

type PayoutRow = Prisma.SellerPayoutGetPayload<{
  select: typeof PAYOUT_SELECT;
}>;

export function presentPayout(p: PayoutRow) {
  return {
    id: p.id,
    sellerId: p.sellerId,
    amount: Number(p.amountUzs),
    method: p.method.toLowerCase(),
    reference: p.reference,
    note: p.note,
    paidAt: p.paidAt.toISOString(),
    createdBy: p.createdByName ?? p.createdByEmail,
    createdAt: p.createdAt.toISOString(),
    voidedAt: p.voidedAt?.toISOString() ?? null,
    voidedBy: p.voidedByEmail,
    voidReason: p.voidReason,
  };
}

type Receipt = Pick<
  PaymeFiscalReceipt,
  | 'type'
  | 'receiptId'
  | 'statusCode'
  | 'message'
  | 'fiscalSign'
  | 'qrCodeUrl'
  | 'fiscalDate'
  | 'conflictCount'
>;

function presentReceipt(r: Receipt) {
  return {
    receiptId: r.receiptId,
    statusCode: r.statusCode,
    message: r.message,
    fiscalSign: r.fiscalSign,
    qrCodeUrl: r.qrCodeUrl,
    date: r.fiscalDate,
    conflicts: r.conflictCount,
  };
}

/**
 * A payment and its fiscal receipts. The tax authority issues the sale and its cancellation as
 * two receipts, both under the payment's one Payme transaction: that transaction is what links
 * them, so the cancellation is shown with the receipt id of the sale it reverses.
 */
export function presentPayment(p: {
  id: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  amountUzs: Prisma.Decimal;
  providerTransactionId: string | null;
  paidAt: Date | null;
  fiscalReceipts: Receipt[];
}) {
  const sale = p.fiscalReceipts.find(
    (r) => r.type === PaymeFiscalReceiptType.PERFORM,
  );
  const cancellation = p.fiscalReceipts.find(
    (r) => r.type === PaymeFiscalReceiptType.CANCEL,
  );
  return {
    paymentId: p.id,
    provider: p.provider.toLowerCase(),
    status: p.status.toLowerCase(),
    amount: Number(p.amountUzs),
    transactionId: p.providerTransactionId,
    paidAt: p.paidAt?.toISOString() ?? null,
    receipts: {
      sale: sale ? presentReceipt(sale) : null,
      cancellation: cancellation
        ? { ...presentReceipt(cancellation), reverses: sale?.receiptId ?? null }
        : null,
    },
  };
}

export type FiscalIssue = ReturnType<typeof presentPayment> & {
  orderId: string;
  problems: (
    | 'sale_receipt_missing'
    | 'sale_receipt_rejected'
    | 'cancel_receipt_missing'
    | 'cancel_receipt_rejected'
    | 'receipt_conflict'
  )[];
};
