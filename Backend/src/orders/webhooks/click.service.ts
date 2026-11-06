import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { OrderStatus, PaymentProvider, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { toTiyin } from '../service-fee.util';
import { SettlementService } from './settlement.service';
import { clickSecret, isClickEnabled } from './click.config';

// Click error codes.
const ERR = {
  SUCCESS: 0,
  SIGN_FAILED: -1,
  BAD_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  ORDER_NOT_FOUND: -5,
  TXN_NOT_FOUND: -6,
  // "Error in request from CLICK" — used when Click is not enabled here.
  DISABLED: -8,
  CANCELLED: -9,
};

/** Two amounts in UZS, compared to the tiyin. Anything that is no number is no match. */
function isSameAmount(
  expected: { toString(): string },
  stated: unknown,
): boolean {
  return toTiyin(Number(expected)) === toTiyin(Number(stated));
}

@Injectable()
export class ClickService {
  private readonly logger = new Logger(ClickService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settlement: SettlementService,
  ) {}

  /**
   * Fail closed: Click is not a live provider unless explicitly enabled
   * (listed in PAYMENT_PROVIDERS AND a non-blank CLICK_SECRET_KEY — see
   * click.config.ts). A disabled provider answers every callback with an error
   * before touching the database, so an unused webhook can never confirm a
   * payment — in particular not one "signed" with an empty secret.
   */
  private disabledReply(p: Record<string, any>) {
    if (isClickEnabled((k) => this.config.get<string>(k))) return null;
    this.logger.warn('Click callback rejected: Click payments are not enabled');
    return this.reply(p, ERR.DISABLED, 'Click payments are not enabled');
  }

  async prepare(p: Record<string, any>) {
    const disabled = this.disabledReply(p);
    if (disabled) return disabled;
    if (!this.verifySign(p, false))
      return this.reply(p, ERR.SIGN_FAILED, 'Sign check failed');

    const order = await this.prisma.order.findUnique({ where: { id: String(p.merchant_trans_id) } });
    if (!order) return this.reply(p, ERR.ORDER_NOT_FOUND, 'Order not found');
    // The order's whole total, service fee and delivery included, to the tiyin.
    if (!isSameAmount(order.totalUzs, p.amount)) {
      return this.reply(p, ERR.BAD_AMOUNT, 'Incorrect amount');
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      return this.reply(p, ERR.ALREADY_PAID, 'Order is not awaiting payment');
    }

    // A repeat of a Prepare already recorded: the same answer, and nothing written. A second
    // row for this transaction is what the unique index would refuse.
    const known = await this.prisma.payment.findFirst({
      where: {
        provider: PaymentProvider.CLICK,
        providerTransactionId: String(p.click_trans_id),
      },
    });
    if (known) {
      return known.orderId === order.id &&
        known.status === PaymentStatus.PENDING
        ? this.reply(p, ERR.SUCCESS, 'Success', known.providerPrepareId)
        : this.reply(
            p,
            ERR.CANCELLED,
            'Transaction cancelled',
            known.providerPrepareId,
          );
    }

    const prepareId = Date.now().toString();
    const data = {
      providerTransactionId: String(p.click_trans_id),
      providerPrepareId: prepareId,
      providerState: 1,
      amountTiyin: null,
    };
    const bindable = await this.prisma.payment.findFirst({
      where: { orderId: order.id, provider: PaymentProvider.CLICK, providerTransactionId: null, status: PaymentStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    if (bindable) {
      await this.prisma.payment.update({ where: { id: bindable.id }, data });
    } else {
      await this.prisma.payment.create({
        data: {
          id: prefixedId(IdPrefix.PAYMENT),
          orderId: order.id,
          provider: PaymentProvider.CLICK,
          status: PaymentStatus.PENDING,
          amountUzs: order.totalUzs,
          ...data,
        },
      });
    }

    return this.reply(p, ERR.SUCCESS, 'Success', prepareId);
  }

  async complete(p: Record<string, any>) {
    const disabled = this.disabledReply(p);
    if (disabled) return disabled;
    if (!this.verifySign(p, true))
      return this.reply(p, ERR.SIGN_FAILED, 'Sign check failed');

    const payment = await this.prisma.payment.findFirst({
      where: { provider: PaymentProvider.CLICK, providerTransactionId: String(p.click_trans_id) },
    });
    if (!payment || String(payment.providerPrepareId) !== String(p.merchant_prepare_id)) {
      return this.reply(p, ERR.TXN_NOT_FOUND, 'Transaction not found');
    }
    if (payment.status === PaymentStatus.PAID) {
      return this.reply(p, ERR.SUCCESS, 'Already confirmed', payment.providerPrepareId);
    }
    // What Prepare agreed to, which holds the whole order total. Checked again here because
    // this is the call that settles the order.
    if (!isSameAmount(payment.amountUzs, p.amount)) {
      return this.reply(
        p,
        ERR.BAD_AMOUNT,
        'Incorrect amount',
        payment.providerPrepareId,
      );
    }

    // Click signals its own failure via a negative `error` field.
    if (Number(p.error) < 0) {
      await this.settlement.markCancelled(payment.id, Number(p.error), false);
      return this.reply(p, ERR.CANCELLED, 'Transaction cancelled', payment.providerPrepareId);
    }
    if (Number(p.action) !== 1) {
      return this.reply(p, ERR.ACTION_NOT_FOUND, 'Action not found', payment.providerPrepareId);
    }

    // Success only for a payment that is settled. An order cancelled meanwhile, or a payment
    // already cancelled, has to reach Click as a failure, so the buyer's money goes back.
    const outcome = await this.settlement.markPaid(payment.id);
    if (outcome !== 'paid' && outcome !== 'already_paid') {
      return this.reply(
        p,
        ERR.CANCELLED,
        'Transaction cancelled',
        payment.providerPrepareId,
      );
    }
    return this.reply(p, ERR.SUCCESS, 'Success', payment.providerPrepareId);
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private verifySign(p: Record<string, any>, isComplete: boolean): boolean {
    // Never verify against an empty secret (the signature would be publicly
    // computable). disabledReply already refuses this; kept as a backstop.
    const secret = clickSecret((k) => this.config.get<string>(k));
    if (!secret) return false;
    const parts = [p.click_trans_id, p.service_id, secret, p.merchant_trans_id];
    if (isComplete) parts.push(p.merchant_prepare_id);
    parts.push(p.amount, p.action, p.sign_time);
    const expected = createHash('md5').update(parts.join('')).digest('hex');
    const provided = String(p.sign_string ?? '');
    // Both are fixed-length hex MD5 digests; guard against length mismatch
    // before the constant-time compare.
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  }

  private reply(p: Record<string, any>, error: number, note: string, prepareId?: string | null) {
    return {
      click_trans_id: p.click_trans_id,
      merchant_trans_id: p.merchant_trans_id,
      merchant_prepare_id: prepareId ?? p.merchant_prepare_id ?? null,
      error,
      error_note: note,
    };
  }
}
