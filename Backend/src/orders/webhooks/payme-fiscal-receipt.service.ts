import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  PaymeFiscalReceipt,
  PaymeFiscalReceiptType,
  PaymentProvider,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FinanceAlerts } from '../finance-alerts';
import {
  FISCAL_STATUS_ACCEPTED,
  FiscalReceiptCallback,
} from './payme-fiscal-receipt.util';

/**
 * What recording a callback did:
 *   recorded  — the first word on this receipt
 *   repeat    — the same callback again; nothing written
 *   replaced  — a later attempt at a receipt not accepted so far
 *   conflict  — differs from an accepted receipt, which stays; kept beside it
 *   not_found — no Payme transaction has this id
 */
export type FiscalReceiptOutcome =
  'recorded' | 'repeat' | 'replaced' | 'conflict' | 'not_found';

/** The transaction states a receipt of each type can follow. */
const EXPECTED_STATES: Record<PaymeFiscalReceiptType, readonly number[]> = {
  [PaymeFiscalReceiptType.PERFORM]: [2, -2],
  [PaymeFiscalReceiptType.CANCEL]: [-2],
};

/** The stored columns a callback decides. */
function receiptFields(callback: FiscalReceiptCallback) {
  return {
    receiptId: callback.receiptId,
    statusCode: callback.statusCode,
    message: callback.message,
    terminalId: callback.terminalId,
    fiscalSign: callback.fiscalSign,
    qrCodeUrl: callback.qrCodeUrl,
    fiscalDate: callback.fiscalDate,
    rawData: callback.raw,
  };
}

function isSameReceipt(
  stored: PaymeFiscalReceipt,
  callback: FiscalReceiptCallback,
): boolean {
  return (
    stored.receiptId === callback.receiptId &&
    stored.statusCode === callback.statusCode &&
    stored.message === callback.message &&
    stored.terminalId === callback.terminalId &&
    stored.fiscalSign === callback.fiscalSign &&
    stored.qrCodeUrl === callback.qrCodeUrl &&
    stored.fiscalDate === callback.fiscalDate
  );
}

/**
 * Keeps the fiscal receipts Payme reports through SetFiscalData: one row per transaction
 * and type, because the tax authority issues the sale and its cancellation as two
 * receipts, and because a unique key is what makes a repeated or concurrent callback
 * harmless. Whatever the state of the payment, a receipt that exists is recorded: it is
 * a fact at the tax authority, and a mismatch is for reconciliation to look at.
 */
@Injectable()
export class PaymeFiscalReceiptService {
  private readonly logger = new Logger(PaymeFiscalReceiptService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly alerts?: FinanceAlerts,
  ) {}

  async record(callback: FiscalReceiptCallback): Promise<FiscalReceiptOutcome> {
    const payment = await this.prisma.payment.findUnique({
      where: {
        provider_providerTransactionId: {
          provider: PaymentProvider.PAYME,
          providerTransactionId: callback.transactionId,
        },
      },
      select: { id: true, orderId: true, providerState: true },
    });
    if (!payment) return 'not_found';
    const subject = {
      paymentId: payment.id,
      orderId: payment.orderId,
      receiptType: callback.type,
      receiptId: callback.receiptId,
    };

    if (
      !EXPECTED_STATES[callback.type].includes(payment.providerState as number)
    ) {
      this.logger.warn(
        `A ${callback.type} receipt came for payment ${payment.id}, in state ${payment.providerState}`,
      );
    }
    if (
      callback.statusCode !== null &&
      callback.statusCode !== FISCAL_STATUS_ACCEPTED
    ) {
      this.logger.warn(
        `Payme reports status ${callback.statusCode} on the ${callback.type} receipt of payment ${payment.id}: ${callback.message ?? 'no message'}`,
      );
      this.alerts?.raise({
        type: 'fiscal_receipt_failed',
        severity: 'critical',
        message: `The ${callback.type} receipt of payment ${payment.id} (order ${payment.orderId}) was not accepted: status ${callback.statusCode}, ${callback.message ?? 'no message'}.`,
        context: { ...subject, statusCode: callback.statusCode },
      });
    }
    // A cancellation receipt reverses the sale receipt of the same transaction, which is how
    // the two are linked. One that comes with no accepted sale receipt reverses nothing on file.
    if (callback.type === PaymeFiscalReceiptType.CANCEL) {
      await this.checkSaleReceipt(payment, subject);
    }

    const key = { paymentId: payment.id, type: callback.type };
    const stored = await this.prisma.paymeFiscalReceipt.findUnique({
      where: { paymentId_type: key },
    });
    if (stored) return this.compare(stored, callback);

    try {
      await this.prisma.paymeFiscalReceipt.create({
        data: { ...key, ...receiptFields(callback) },
      });
      return 'recorded';
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2002'
      ) {
        throw err;
      }
    }
    // A concurrent copy got there first, and the unique key stopped this one.
    return this.compare(
      await this.prisma.paymeFiscalReceipt.findUniqueOrThrow({
        where: { paymentId_type: key },
      }),
      callback,
    );
  }

  /** Says so when a cancellation receipt has no accepted sale receipt to reverse. */
  private async checkSaleReceipt(
    payment: { id: string; orderId: string },
    subject: Record<string, string | null>,
  ): Promise<void> {
    const sale = await this.prisma.paymeFiscalReceipt.findUnique({
      where: {
        paymentId_type: {
          paymentId: payment.id,
          type: PaymeFiscalReceiptType.PERFORM,
        },
      },
      select: { statusCode: true, receiptId: true },
    });
    if (sale?.statusCode === FISCAL_STATUS_ACCEPTED) return;
    this.alerts?.raise({
      type: 'fiscal_receipt_conflict',
      severity: 'warning',
      message: `A cancellation receipt came for payment ${payment.id} (order ${payment.orderId}), which has no accepted sale receipt for it to reverse.`,
      context: { ...subject, saleReceiptId: sale?.receiptId ?? null },
    });
  }

  /**
   * A second callback about a receipt we hold. The same one changes nothing. A receipt
   * not accepted so far takes the later attempt, conditionally, so an acceptance that
   * landed a moment ago is never overwritten. An accepted one stays exactly as it is.
   */
  private async compare(
    stored: PaymeFiscalReceipt,
    callback: FiscalReceiptCallback,
  ): Promise<FiscalReceiptOutcome> {
    if (isSameReceipt(stored, callback)) return 'repeat';
    const key = { paymentId: stored.paymentId, type: stored.type };

    const replaced = await this.prisma.paymeFiscalReceipt.updateMany({
      where: {
        ...key,
        OR: [
          { statusCode: null },
          { statusCode: { not: FISCAL_STATUS_ACCEPTED } },
        ],
      },
      data: receiptFields(callback),
    });
    if (replaced.count > 0) return 'replaced';

    this.logger.error(
      `Payme sent a different ${stored.type} receipt for payment ${stored.paymentId}, which already holds an accepted one. Kept the accepted one.`,
    );
    this.alerts?.raise({
      type: 'fiscal_receipt_conflict',
      severity: 'warning',
      message: `Payme sent a different ${stored.type} receipt for payment ${stored.paymentId}, which already holds an accepted one. The accepted one was kept.`,
      context: {
        paymentId: stored.paymentId,
        receiptType: stored.type,
        receiptId: callback.receiptId,
        acceptedReceiptId: stored.receiptId,
      },
    });
    await this.prisma.paymeFiscalReceipt.update({
      where: { paymentId_type: key },
      data: {
        conflictCount: { increment: 1 },
        lastConflictData: callback.raw,
        lastConflictAt: new Date(),
      },
    });
    return 'conflict';
  }
}
