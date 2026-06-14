import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, PaymentProvider, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { SettlementService } from './settlement.service';

// Payme JSON-RPC error codes.
class PaymeError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}
const L = (text: string) => ({ ru: text, uz: text, en: text });

interface JsonRpcBody {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
}

@Injectable()
export class PaymeService {
  private readonly logger = new Logger(PaymeService.name);
  private readonly accountField: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settlement: SettlementService,
  ) {
    this.accountField = this.config.get<string>('PAYME_ACCOUNT_FIELD') ?? 'order_id';
  }

  /** Entry point: authorize, dispatch, and wrap the JSON-RPC envelope. */
  async handle(authHeader: string | undefined, body: JsonRpcBody) {
    try {
      this.authorize(authHeader);
      const result = await this.dispatch(body.method, body.params ?? {});
      return { jsonrpc: '2.0', id: body.id ?? null, result };
    } catch (err) {
      if (err instanceof PaymeError) {
        return {
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: err.code, message: L(err.message), data: err.data },
        };
      }
      this.logger.error(`Payme handler error: ${(err as Error).message}`);
      return { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32400, message: L('Internal error') } };
    }
  }

  private authorize(authHeader?: string): void {
    const key = this.config.get<string>('PAYME_MERCHANT_KEY') ?? '';
    const expected = 'Basic ' + Buffer.from(`Paycom:${key}`).toString('base64');
    if (!authHeader || authHeader !== expected) {
      throw new PaymeError(-32504, 'Insufficient privilege to perform this method');
    }
  }

  private dispatch(method: string | undefined, params: Record<string, any>) {
    switch (method) {
      case 'CheckPerformTransaction':
        return this.checkPerform(params);
      case 'CreateTransaction':
        return this.createTransaction(params);
      case 'PerformTransaction':
        return this.performTransaction(params);
      case 'CancelTransaction':
        return this.cancelTransaction(params);
      case 'CheckTransaction':
        return this.checkTransaction(params);
      case 'GetStatement':
        return this.getStatement(params);
      default:
        throw new PaymeError(-32601, 'Method not found');
    }
  }

  // ── methods ──────────────────────────────────────────────────────────────
  private async checkPerform(params: Record<string, any>) {
    const order = await this.orderFromAccount(params);
    this.assertAmount(order.totalUzs, params.amount);
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new PaymeError(-31008, 'Order is not awaiting payment');
    }
    return { allow: true };
  }

  private async createTransaction(params: Record<string, any>) {
    const existing = await this.byPaymeId(params.id);
    if (existing) {
      if (existing.providerState === 1) {
        return { create_time: Number(existing.providerCreateTime), transaction: existing.id, state: 1 };
      }
      throw new PaymeError(-31008, 'Transaction is in a final state');
    }

    const order = await this.orderFromAccount(params);
    this.assertAmount(order.totalUzs, params.amount);
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new PaymeError(-31008, 'Order is not awaiting payment');
    }
    const active = await this.prisma.payment.findFirst({
      where: { orderId: order.id, provider: PaymentProvider.PAYME, providerState: 1 },
    });
    if (active) throw new PaymeError(-31008, 'Another transaction is in progress for this order');

    const createTime = Number(params.time ?? Date.now());
    const bindable = await this.prisma.payment.findFirst({
      where: { orderId: order.id, provider: PaymentProvider.PAYME, providerTransactionId: null, status: PaymentStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });

    const data = {
      providerTransactionId: String(params.id),
      providerState: 1,
      providerCreateTime: BigInt(createTime),
      amountTiyin: BigInt(params.amount),
    };
    const payment = bindable
      ? await this.prisma.payment.update({ where: { id: bindable.id }, data })
      : await this.prisma.payment.create({
          data: {
            id: prefixedId(IdPrefix.PAYMENT),
            orderId: order.id,
            provider: PaymentProvider.PAYME,
            status: PaymentStatus.PENDING,
            amountUzs: order.totalUzs,
            ...data,
          },
        });

    return { create_time: createTime, transaction: payment.id, state: 1 };
  }

  private async performTransaction(params: Record<string, any>) {
    const payment = await this.byPaymeId(params.id);
    if (!payment) throw new PaymeError(-31003, 'Transaction not found');
    if (payment.providerState === 2) {
      return { transaction: payment.id, perform_time: Number(payment.providerPerformTime), state: 2 };
    }
    if (payment.providerState !== 1) throw new PaymeError(-31008, 'Transaction cannot be performed');

    const performTime = Date.now();
    await this.settlement.markPaid(payment.id, performTime);
    return { transaction: payment.id, perform_time: performTime, state: 2 };
  }

  private async cancelTransaction(params: Record<string, any>) {
    const payment = await this.byPaymeId(params.id);
    if (!payment) throw new PaymeError(-31003, 'Transaction not found');

    if (payment.providerState === 1) {
      await this.settlement.markCancelled(payment.id, Number(params.reason), false);
      return { transaction: payment.id, cancel_time: Date.now(), state: -1 };
    }
    if (payment.providerState === 2) {
      await this.settlement.markCancelled(payment.id, Number(params.reason), true);
      return { transaction: payment.id, cancel_time: Date.now(), state: -2 };
    }
    // already cancelled — return stored state
    return {
      transaction: payment.id,
      cancel_time: Number(payment.providerCancelTime ?? Date.now()),
      state: payment.providerState ?? -1,
    };
  }

  private async checkTransaction(params: Record<string, any>) {
    const payment = await this.byPaymeId(params.id);
    if (!payment) throw new PaymeError(-31003, 'Transaction not found');
    return {
      create_time: Number(payment.providerCreateTime ?? 0),
      perform_time: Number(payment.providerPerformTime ?? 0),
      cancel_time: Number(payment.providerCancelTime ?? 0),
      transaction: payment.id,
      state: payment.providerState ?? 0,
      reason: payment.cancelReason ?? null,
    };
  }

  private async getStatement(params: Record<string, any>) {
    const from = BigInt(Number(params.from ?? 0));
    const to = BigInt(Number(params.to ?? Date.now()));
    const payments = await this.prisma.payment.findMany({
      where: { provider: PaymentProvider.PAYME, providerCreateTime: { gte: from, lte: to } },
    });
    return {
      transactions: payments.map((p) => ({
        id: p.providerTransactionId,
        time: Number(p.providerCreateTime ?? 0),
        amount: Number(p.amountTiyin ?? 0),
        account: { [this.accountField]: p.orderId },
        create_time: Number(p.providerCreateTime ?? 0),
        perform_time: Number(p.providerPerformTime ?? 0),
        cancel_time: Number(p.providerCancelTime ?? 0),
        transaction: p.id,
        state: p.providerState ?? 0,
        reason: p.cancelReason ?? null,
      })),
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private byPaymeId(paymeId: unknown) {
    return this.prisma.payment.findFirst({
      where: { provider: PaymentProvider.PAYME, providerTransactionId: String(paymeId) },
    });
  }

  private async orderFromAccount(params: Record<string, any>) {
    const orderId = params.account?.[this.accountField];
    if (!orderId) throw new PaymeError(-31050, 'Order not found', this.accountField);
    const order = await this.prisma.order.findUnique({ where: { id: String(orderId) } });
    if (!order) throw new PaymeError(-31050, 'Order not found', this.accountField);
    return order;
  }

  private assertAmount(totalUzs: { toString(): string }, amountTiyin: unknown): void {
    const expected = Math.round(Number(totalUzs) * 100);
    if (Number(amountTiyin) !== expected) {
      throw new PaymeError(-31001, 'Incorrect amount');
    }
  }
}
