import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { OrderStatus, PaymentProvider, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { SettlementService } from './settlement.service';

// Click error codes.
const ERR = {
  SUCCESS: 0,
  SIGN_FAILED: -1,
  BAD_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  ORDER_NOT_FOUND: -5,
  TXN_NOT_FOUND: -6,
  CANCELLED: -9,
};

@Injectable()
export class ClickService {
  private readonly logger = new Logger(ClickService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settlement: SettlementService,
  ) {}

  async prepare(p: Record<string, any>) {
    if (!this.verifySign(p, false)) return this.reply(p, ERR.SIGN_FAILED, 'Sign check failed');

    const order = await this.prisma.order.findUnique({ where: { id: String(p.merchant_trans_id) } });
    if (!order) return this.reply(p, ERR.ORDER_NOT_FOUND, 'Order not found');
    if (Math.round(Number(order.totalUzs)) !== Math.round(Number(p.amount))) {
      return this.reply(p, ERR.BAD_AMOUNT, 'Incorrect amount');
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      return this.reply(p, ERR.ALREADY_PAID, 'Order is not awaiting payment');
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
    if (!this.verifySign(p, true)) return this.reply(p, ERR.SIGN_FAILED, 'Sign check failed');

    const payment = await this.prisma.payment.findFirst({
      where: { provider: PaymentProvider.CLICK, providerTransactionId: String(p.click_trans_id) },
    });
    if (!payment || String(payment.providerPrepareId) !== String(p.merchant_prepare_id)) {
      return this.reply(p, ERR.TXN_NOT_FOUND, 'Transaction not found');
    }
    if (payment.status === PaymentStatus.PAID) {
      return this.reply(p, ERR.SUCCESS, 'Already confirmed', payment.providerPrepareId);
    }

    // Click signals its own failure via a negative `error` field.
    if (Number(p.error) < 0) {
      await this.settlement.markCancelled(payment.id, Number(p.error), false);
      return this.reply(p, ERR.CANCELLED, 'Transaction cancelled', payment.providerPrepareId);
    }
    if (Number(p.action) !== 1) {
      return this.reply(p, ERR.ACTION_NOT_FOUND, 'Action not found', payment.providerPrepareId);
    }

    await this.settlement.markPaid(payment.id);
    return this.reply(p, ERR.SUCCESS, 'Success', payment.providerPrepareId);
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private verifySign(p: Record<string, any>, isComplete: boolean): boolean {
    const secret = this.config.get<string>('CLICK_SECRET_KEY') ?? '';
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
