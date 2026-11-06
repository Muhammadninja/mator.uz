import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentProvider,
  PaymentStatus,
  PaymeFiscalReceiptType,
  Prisma,
  RefundMethod,
  RefundSource,
} from '@prisma/client';
import { readRefundPosition } from '../../orders/financial-refund.ledger';
import { toTiyin } from '../../orders/service-fee.util';
import { FISCAL_STATUS_ACCEPTED } from '../../orders/webhooks/payme-fiscal-receipt.util';
import { readPaymeConfig } from '../../orders/webhooks/payme.config';
import {
  paymeStatementQuery,
  presentStatementTransaction,
} from '../../orders/webhooks/payme-statement';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import {
  ADMIN_REFUND_SELECT,
  presentPosition,
  presentRefund,
} from '../refunds/admin-refunds.presenter';
import { FiscalIssue, presentPayment } from './admin-finance.presenter';
import { FiscalIssuesQueryDto, StatementQueryDto } from './dto/payout.dto';
import { PAYABLE_ORDER, sellerNames } from './seller-ledger';

const DEFAULT_GRACE_MINUTES = 60;
const MAX_ISSUES = 200;
/** A reconciliation window: wide enough for a month's statement, narrow enough to read. */
const MAX_STATEMENT_WINDOW_MS = 92 * 24 * 60 * 60 * 1000;

/** The payment status each Payme transaction state stands for in this system. */
const STATUS_FOR_STATE: Record<number, PaymentStatus> = {
  1: PaymentStatus.PENDING,
  2: PaymentStatus.PAID,
  [-1]: PaymentStatus.CANCELLED,
  [-2]: PaymentStatus.REFUNDED,
};

/**
 * Looking at the money rather than moving it: one order's money by whose it is, the payments
 * and refunds whose tax receipts need a person, and Payme's statement checked against the
 * registry.
 */
@Injectable()
export class AdminFinanceChecksService {
  private readonly accountField: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.accountField = readPaymeConfig((key) =>
      config.get<string>(key),
    ).accountField;
  }

  /**
   * One order's money: what it charged, what came in and went back of each kind, whose each
   * part is, Mator's commission and what each seller nets, whether it can be paid out, and its
   * payments and refunds with their tax receipts, each cancellation receipt beside the sale
   * receipt it reverses.
   */
  async order(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        paymentType: true,
        subtotalUzs: true,
        discountUzs: true,
        serviceFeeUzs: true,
        deliveryUzs: true,
        totalUzs: true,
        payoutHoldAt: true,
        payoutHoldReason: true,
        items: { select: { sellerId: true, commissionPercent: true } },
        payments: {
          select: {
            id: true,
            provider: true,
            status: true,
            amountUzs: true,
            providerTransactionId: true,
            paidAt: true,
            fiscalReceipts: true,
          },
          orderBy: { createdAt: 'asc' },
        },
        financialRefunds: {
          select: ADMIN_REFUND_SELECT,
          orderBy: [{ refundedAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const [position, payable] = await Promise.all([
      readRefundPosition(this.prisma, orderId),
      this.prisma.order.count({ where: { ...PAYABLE_ORDER, id: orderId } }),
    ]);
    const names = await sellerNames(
      this.prisma,
      position.sellers.map((s) => s.sellerId),
    );
    const rateOf = (sellerId: string) =>
      Number(
        order.items.find((i) => i.sellerId === sellerId)?.commissionPercent ??
          0,
      );
    const presented = presentPosition(position);
    return {
      success: true,
      data: {
        orderId: order.id,
        status: order.status.toLowerCase(),
        paymentType: order.paymentType?.toLowerCase() ?? null,
        charges: {
          itemsSubtotal: Number(order.subtotalUzs),
          discount: Number(order.discountUzs),
          serviceFee: Number(order.serviceFeeUzs),
          delivery: Number(order.deliveryUzs),
          total: Number(order.totalUzs),
        },
        position: {
          ...presented,
          sellers: position.sellers.map((s, i) => ({
            ...presented.sellers[i],
            name: names.get(s.sellerId) ?? null,
            commissionPercent: rateOf(s.sellerId),
            // What the seller nets from this order as it stands: goods not returned, less the
            // commission still charged on them.
            net: Number(s.remaining.sub(s.commission.remaining)),
          })),
        },
        payout: {
          payable: payable > 0,
          holdAt: order.payoutHoldAt?.toISOString() ?? null,
          holdReason: order.payoutHoldReason,
        },
        payments: order.payments.map(presentPayment),
        refunds: order.financialRefunds.map(presentRefund),
      },
    };
  }

  /**
   * What needs a tax receipt someone has to look at:
   *   • Payme payments with money taken and no accepted sale receipt, money returned and no
   *     accepted cancellation receipt, or a receipt the tax authority refused or Payme
   *     contradicted. Payme reports receipts some time after the payment, and may never report
   *     one, so a payment counts only after a grace period;
   *   • refunds made outside Payme, partial ones included, that nobody has recorded a return
   *     receipt for. An entry in the registry is never a receipt by itself: cash, terminal and
   *     transfer refunds need their own fiscal process;
   *   • refunds an operator recorded as made through Payme that Payme has not reversed: no
   *     receipt can come for them until it does.
   */
  async fiscalIssues(query: FiscalIssuesQueryDto) {
    const graceMs = (query.graceMinutes ?? DEFAULT_GRACE_MINUTES) * 60_000;
    const before = new Date(Date.now() - graceMs);
    const accepted = (type: PaymeFiscalReceiptType) => ({
      none: { type, statusCode: FISCAL_STATUS_ACCEPTED },
    });

    const [rows, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          provider: PaymentProvider.PAYME,
          OR: [
            {
              status: { in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] },
              paidAt: { lte: before },
              fiscalReceipts: accepted(PaymeFiscalReceiptType.PERFORM),
            },
            {
              status: PaymentStatus.REFUNDED,
              providerCancelTime: { lte: BigInt(before.getTime()) },
              fiscalReceipts: accepted(PaymeFiscalReceiptType.CANCEL),
            },
            {
              fiscalReceipts: {
                some: {
                  OR: [
                    { conflictCount: { gt: 0 } },
                    { statusCode: { not: FISCAL_STATUS_ACCEPTED } },
                  ],
                },
              },
            },
          ],
        },
        select: {
          id: true,
          orderId: true,
          provider: true,
          status: true,
          amountUzs: true,
          providerTransactionId: true,
          paidAt: true,
          fiscalReceipts: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: MAX_ISSUES,
      }),
      this.prisma.financialRefund.findMany({
        where: {
          voidedAt: null,
          source: RefundSource.MANUAL,
          refundedAt: { lte: before },
          OR: [
            { method: { not: RefundMethod.PROVIDER }, fiscalReference: null },
            { method: RefundMethod.PROVIDER, providerConfirmedAt: null },
          ],
        },
        select: ADMIN_REFUND_SELECT,
        orderBy: [{ refundedAt: 'desc' }, { id: 'asc' }],
        take: MAX_ISSUES,
      }),
    ]);

    const payments: FiscalIssue[] = rows
      .map((row) => ({
        ...presentPayment(row),
        orderId: row.orderId,
        problems: problemsOf(row),
      }))
      .filter((issue) => issue.problems.length > 0);
    return {
      success: true,
      data: {
        payments,
        refunds: refunds.map(presentRefund),
      },
    };
  }

  /**
   * Payme's statement for a window, exactly as GetStatement gives it, each transaction checked
   * against the payment row and the refund registry:
   *   • `state_mismatch` — the payment's status is not the one the transaction's state means;
   *   • `amount_mismatch` — the transaction is not for the order's total;
   *   • `refund_not_in_registry` — Payme reversed it, and the registry does not hold all of it;
   *   • `refund_without_money` — the registry holds a refund of money this transaction never took;
   *   • `refunded_outside_payme` — Payme still holds it as paid, and the registry says all of it
   *     went back some other way: legitimate, but worth a look.
   */
  async paymeStatement(query: StatementQueryDto) {
    if (
      query.to < query.from ||
      query.to - query.from > MAX_STATEMENT_WINDOW_MS
    ) {
      throw new BadRequestException({
        code: 'STATEMENT_WINDOW_INVALID',
        message: 'The window has to run forwards and span at most 92 days.',
      });
    }
    const rows = await this.prisma.payment.findMany({
      ...paymeStatementQuery(BigInt(query.from), BigInt(query.to)),
      include: {
        order: { select: { totalUzs: true } },
        financialRefunds: {
          where: { voidedAt: null },
          select: { amountUzs: true },
        },
      },
    });

    const transactions = rows.map((row) => {
      const refunded = row.financialRefunds.reduce(
        (sum, entry) => sum.add(entry.amountUzs),
        new Prisma.Decimal(0),
      );
      const state = row.providerState ?? 0;
      const problems: string[] = [];
      if (STATUS_FOR_STATE[state] !== row.status)
        problems.push('state_mismatch');
      if (
        Number(row.amountTiyin ?? 0) !== toTiyin(Number(row.order.totalUzs))
      ) {
        problems.push('amount_mismatch');
      }
      if (state === -2 && !refunded.eq(row.amountUzs)) {
        problems.push('refund_not_in_registry');
      }
      if ((state === 1 || state === -1) && refunded.gt(0)) {
        problems.push('refund_without_money');
      }
      if (state === 2 && refunded.gte(row.amountUzs)) {
        problems.push('refunded_outside_payme');
      }
      return {
        ...presentStatementTransaction(row, this.accountField),
        paymentStatus: row.status.toLowerCase(),
        refundedInRegistry: Number(refunded),
        problems,
      };
    });
    return {
      success: true,
      data: transactions,
      meta: {
        count: transactions.length,
        withProblems: transactions.filter((t) => t.problems.length > 0).length,
      },
    };
  }
}

/** What is wrong with a payment's receipts, in the words an operator acts on. */
function problemsOf(payment: {
  status: PaymentStatus;
  fiscalReceipts: {
    type: PaymeFiscalReceiptType;
    statusCode: number | null;
    conflictCount: number;
  }[];
}): FiscalIssue['problems'] {
  const of = (type: PaymeFiscalReceiptType) =>
    payment.fiscalReceipts.find((r) => r.type === type);
  const refused = (r?: { statusCode: number | null }) =>
    !!r && r.statusCode !== null && r.statusCode !== FISCAL_STATUS_ACCEPTED;
  const problems: FiscalIssue['problems'] = [];
  const sale = of(PaymeFiscalReceiptType.PERFORM);
  const cancellation = of(PaymeFiscalReceiptType.CANCEL);
  const tookMoney =
    payment.status === PaymentStatus.PAID ||
    payment.status === PaymentStatus.REFUNDED;
  if (tookMoney && !sale) problems.push('sale_receipt_missing');
  if (refused(sale)) problems.push('sale_receipt_rejected');
  if (payment.status === PaymentStatus.REFUNDED && !cancellation) {
    problems.push('cancel_receipt_missing');
  }
  if (refused(cancellation)) problems.push('cancel_receipt_rejected');
  if (payment.fiscalReceipts.some((r) => r.conflictCount > 0)) {
    problems.push('receipt_conflict');
  }
  return problems;
}
