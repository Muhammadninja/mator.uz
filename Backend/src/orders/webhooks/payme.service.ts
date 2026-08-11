import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import {
  OrderStatus,
  Payment,
  PaymentProvider,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { SettlementService } from './settlement.service';
import { readPaymeConfig } from './payme.config';
import {
  FiscalDataIncompleteException,
  PaymeFiscalService,
} from './payme-fiscal.service';
import type { PaymeReceiptDetail } from './payme-fiscal.util';

/** Constant-time string equality (hash to a fixed length first so unequal
 * lengths don't short-circuit and leak timing). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Payme JSON-RPC error codes.
class PaymeError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}
const L = (text: string) => ({ ru: text, uz: text, en: text });

/**
 * Payme transaction states, as sent on the wire. A payment row mirrors these in
 * `providerState`, which is what CheckTransaction reports back verbatim.
 */
export const PaymeState = {
  CREATED: 1,
  PERFORMED: 2,
  CANCELLED: -1,
  CANCELLED_AFTER_PERFORM: -2,
} as const;

/**
 * A created-but-unperformed transaction may be confirmed for 12 hours
 * (43_200_000 ms). Past that Payme expects the merchant to cancel it with
 * reason 4 ("transaction timed out") and to refuse Perform.
 *
 * Expiry is evaluated lazily, on the next Create/Perform touching the row,
 * rather than by a dedicated cron: Payme only observes a transaction through
 * these calls, so a sweeper would add moving parts without changing any
 * externally visible answer.
 */
export const PAYME_TRANSACTION_TIMEOUT_MS = 43_200_000;

/** Payme cancellation reason for "transaction timed out". */
export const PAYME_TIMEOUT_REASON = 4;

/** Order statuses past which a performed payment can no longer be refunded. */
const UNREFUNDABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

interface JsonRpcBody {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
}

@Injectable()
export class PaymeService {
  private readonly logger = new Logger(PaymeService.name);
  private readonly accountField: string;
  private readonly merchantKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settlement: SettlementService,
    private readonly fiscal: PaymeFiscalService,
  ) {
    const payme = readPaymeConfig((key) => this.config.get<string>(key));
    this.accountField = payme.accountField;
    this.merchantKey = payme.merchantKey;
  }

  /**
   * Entry point for a raw request body: parse, then hand off to {@link handle}.
   *
   * Payme requires HTTP 200 with a JSON-RPC error for EVERY failure, including
   * an unparseable body (-32700). Nest's default pipeline would answer a syntax
   * error with HTTP 400 and our own `{code, message}` envelope, which Payme
   * reads as -32400, so the raw text is parsed here instead.
   */
  async handleRaw(authHeader: string | undefined, raw: unknown) {
    let body: JsonRpcBody;
    try {
      body = this.parseBody(raw);
    } catch {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: L('Could not parse JSON') },
      };
    }
    return this.handle(authHeader, body);
  }

  /** Coerce a raw body (Buffer, string, or already-parsed object) to JSON-RPC. */
  private parseBody(raw: unknown): JsonRpcBody {
    if (Buffer.isBuffer(raw))
      return JSON.parse(raw.toString('utf8')) as JsonRpcBody;
    if (typeof raw === 'string') return JSON.parse(raw) as JsonRpcBody;
    if (raw && typeof raw === 'object') return raw as JsonRpcBody;
    throw new SyntaxError('Unparseable Payme request body');
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
      // Never let an internal message reach Payme: log it, answer -32400.
      this.logger.error(`Payme handler error: ${(err as Error).message}`);
      return {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32400, message: L('Internal error') },
      };
    }
  }

  /**
   * Basic auth against the merchant key. A blank key is NEVER accepted: with an
   * empty secret the expected header collapses to `Basic base64("Paycom:")`,
   * which anyone can compute, so we fail closed and deny every caller. In
   * production this state is unreachable — {@link validatePaymeEnv} aborts
   * bootstrap — but a dev/test process with no key configured must still refuse
   * rather than authorize the world.
   */
  private authorize(authHeader?: string): void {
    if (!this.merchantKey) {
      this.logger.error(
        'PAYME_MERCHANT_KEY is not configured — denying Payme webhook request.',
      );
      throw new PaymeError(
        -32504,
        'Insufficient privilege to perform this method',
      );
    }
    const expected =
      'Basic ' + Buffer.from(`Paycom:${this.merchantKey}`).toString('base64');
    if (!authHeader || !safeEqual(authHeader, expected)) {
      throw new PaymeError(
        -32504,
        'Insufficient privilege to perform this method',
      );
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

    // Fiscalization. Payme takes the receipt from THIS reply, so the items are
    // built here — per item, each with its own dealer's TIN and VAT rate, so an
    // order spanning several dealers settles correctly.
    //
    // An order whose fiscal data is incomplete is REFUSED rather than allowed
    // with a partial receipt: sending malformed fiscal data is worse than a
    // failed payment, and the checkout path already rejects such an order
    // before it ever gets here (see PaymentsService.createPaymeInvoice), so in
    // practice this is the backstop for data that changed in between.
    let detail: PaymeReceiptDetail | null;
    try {
      detail = await this.fiscal.buildOrderDetail(order.id);
    } catch (err) {
      if (err instanceof FiscalDataIncompleteException) {
        throw new PaymeError(-31008, 'Order cannot be fiscalized');
      }
      throw err;
    }

    // An order with no product lines (services only) carries no fiscal items;
    // it is allowed exactly as it was before fiscalization existed.
    return detail ? { allow: true, detail } : { allow: true };
  }

  /**
   * Create (or idempotently re-report) a transaction.
   *
   * Payme retries and parallelises calls, so this races with itself in two ways,
   * both closed here:
   *
   *  a) the SAME `params.id` arriving twice — serialised by the unique index on
   *     (provider, providerTransactionId). The loser of the race gets P2002,
   *     re-reads the winner's row and returns its stored `create_time`, so both
   *     responses are identical and only one payment row exists.
   *  b) DIFFERENT ids for the same order — rejected by the "one active
   *     transaction per order" check, which runs inside the same transaction as
   *     the insert so a concurrent creator cannot slip past a stale read.
   */
  private async createTransaction(params: Record<string, any>) {
    const paymeId = String(params.id);
    const existing = await this.byPaymeId(paymeId);
    if (existing) return this.reportCreated(existing);

    const order = await this.orderFromAccount(params);
    this.assertAmount(order.totalUzs, params.amount);
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new PaymeError(-31008, 'Order is not awaiting payment');
    }

    // Payme supplies the authoritative creation time; fall back to ours only if
    // the field is absent, so `create_time` echoes what Payme recorded.
    const createTime = Number(params.time ?? Date.now());
    const amountTiyin = BigInt(params.amount);

    try {
      const payment = await this.prisma.$transaction(async (tx) => {
        // Serialise concurrent creators for THIS order (case b) by taking a
        // row-level lock on it first. Under PostgreSQL's default READ COMMITTED
        // isolation two transactions would otherwise both read "no active
        // transaction" and both insert — a plain findFirst-then-create is a
        // read-modify-write race, not a guard. `FOR UPDATE` makes the second
        // caller block here until the first commits, so it observes the
        // transaction that was just created and is correctly refused below.
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;

        const active = await tx.payment.findFirst({
          where: {
            orderId: order.id,
            provider: PaymentProvider.PAYME,
            providerState: PaymeState.CREATED,
          },
        });
        if (active) {
          // The active transaction may be THIS one: a duplicate request that was
          // waiting on the lock while the winner committed. That is a repeat, not
          // a competitor, so report it idempotently — checking the id before
          // refusing is what keeps concurrent same-id calls returning the same
          // answer instead of one of them getting an error.
          if (active.providerTransactionId === paymeId) return active;
          if (this.isExpired(active, createTime)) {
            // The incumbent timed out; cancel it so this order is payable again
            // rather than being wedged by an abandoned transaction.
            await this.expireInTx(tx, active);
          } else {
            // A DIFFERENT transaction already holds this order. Payme classes
            // this as an account-level problem, not a transaction-state one: the
            // account named in `params.account` cannot accept a new payment, so
            // the answer must fall in the -31050..-31099 range and carry the
            // offending account field in `data` (the sandbox asserts the range).
            // -31008 is reserved here for transaction-state failures and stays
            // in place for those.
            throw new PaymeError(
              -31050,
              'Another transaction is in progress for this order',
              this.accountField,
            );
          }
        }

        const data = {
          providerTransactionId: paymeId,
          providerState: PaymeState.CREATED,
          providerCreateTime: BigInt(createTime),
          amountTiyin,
        };
        // Reuse the invoice row the customer created (POST /payme/invoices) when
        // one is still unbound, so an order keeps a single payment row.
        const bindable = await tx.payment.findFirst({
          where: {
            orderId: order.id,
            provider: PaymentProvider.PAYME,
            providerTransactionId: null,
            status: PaymentStatus.PENDING,
          },
          orderBy: { createdAt: 'desc' },
        });
        return bindable
          ? tx.payment.update({ where: { id: bindable.id }, data })
          : tx.payment.create({
              data: {
                id: prefixedId(IdPrefix.PAYMENT),
                orderId: order.id,
                provider: PaymentProvider.PAYME,
                status: PaymentStatus.PENDING,
                amountUzs: order.totalUzs,
                ...data,
              },
            });
      });

      // Report the PERSISTED create time, not our local `createTime`: when the
      // block above returned an already-existing row (a duplicate that waited on
      // the lock), the stored value is the winner's and both callers must see the
      // same answer. For a freshly inserted row the two are identical anyway.
      return {
        create_time: Number(payment.providerCreateTime ?? createTime),
        transaction: payment.id,
        state: PaymeState.CREATED,
      };
    } catch (err) {
      // Case (a): the unique index rejected our insert because a concurrent
      // request created this very transaction. Report the winner's row.
      if (this.isUniqueViolation(err)) {
        const winner = await this.byPaymeId(paymeId);
        if (winner) return this.reportCreated(winner);
      }
      throw err;
    }
  }

  /**
   * Shape the CreateTransaction reply for an existing row, applying the lazy
   * timeout first: a transaction older than 12 hours is cancelled (reason 4) and
   * reported as un-performable rather than handed back as still-payable.
   */
  private async reportCreated(payment: Payment) {
    if (payment.providerState === PaymeState.CREATED) {
      if (this.isExpired(payment)) {
        await this.expire(payment);
        throw new PaymeError(-31008, 'Transaction timed out');
      }
      return {
        create_time: Number(payment.providerCreateTime ?? 0),
        transaction: payment.id,
        state: PaymeState.CREATED,
      };
    }
    throw new PaymeError(-31008, 'Transaction is in a final state');
  }

  private async performTransaction(params: Record<string, any>) {
    const payment = await this.byPaymeId(params.id);
    if (!payment) throw new PaymeError(-31003, 'Transaction not found');

    // Idempotent: a repeat Perform must echo the STORED perform_time, never a
    // fresh clock read, or Payme sees the timestamp drift between calls.
    if (payment.providerState === PaymeState.PERFORMED) {
      return {
        transaction: payment.id,
        perform_time: Number(payment.providerPerformTime ?? 0),
        state: PaymeState.PERFORMED,
      };
    }
    if (payment.providerState !== PaymeState.CREATED) {
      throw new PaymeError(-31008, 'Transaction cannot be performed');
    }
    if (this.isExpired(payment)) {
      await this.expire(payment);
      throw new PaymeError(-31008, 'Transaction timed out');
    }

    const performTime = Date.now();
    await this.settlement.markPaid(payment.id, performTime);
    // Re-read so the reply carries the persisted timestamp: if a concurrent
    // Perform settled first, markPaid was a no-op and the stored value — not
    // ours — is the one Payme must keep seeing.
    const settled = await this.byPaymeId(params.id);
    return {
      transaction: payment.id,
      perform_time: Number(settled?.providerPerformTime ?? performTime),
      state: PaymeState.PERFORMED,
    };
  }

  private async cancelTransaction(params: Record<string, any>) {
    const payment = await this.byPaymeId(params.id);
    if (!payment) throw new PaymeError(-31003, 'Transaction not found');
    const reason =
      params.reason === undefined || params.reason === null
        ? null
        : Number(params.reason);

    // Already cancelled — replay the stored outcome verbatim (idempotent).
    if (
      payment.providerState === PaymeState.CANCELLED ||
      payment.providerState === PaymeState.CANCELLED_AFTER_PERFORM
    ) {
      return {
        transaction: payment.id,
        cancel_time: Number(payment.providerCancelTime ?? 0),
        state: payment.providerState,
      };
    }

    if (payment.providerState === PaymeState.PERFORMED) {
      // A refund is only possible while the goods have not been handed over.
      const order = await this.prisma.order.findUnique({
        where: { id: payment.orderId },
      });
      if (order && UNREFUNDABLE_ORDER_STATUSES.includes(order.status)) {
        throw new PaymeError(
          -31007,
          'Order has been delivered. Transaction cannot be cancelled',
        );
      }
      await this.settlement.markCancelled(
        payment.id,
        reason ?? undefined,
        true,
      );
      return this.reportCancelled(
        payment.id,
        PaymeState.CANCELLED_AFTER_PERFORM,
      );
    }

    await this.settlement.markCancelled(payment.id, reason ?? undefined, false);
    return this.reportCancelled(payment.id, PaymeState.CANCELLED);
  }

  /** Re-read a just-cancelled payment so the reply carries the persisted time. */
  private async reportCancelled(paymentId: string, fallbackState: number) {
    const stored = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    return {
      transaction: paymentId,
      cancel_time: Number(stored?.providerCancelTime ?? 0),
      state: stored?.providerState ?? fallbackState,
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
      where: {
        provider: PaymentProvider.PAYME,
        providerCreateTime: { gte: from, lte: to },
      },
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
    return this.prisma.payment.findUnique({
      where: {
        provider_providerTransactionId: {
          provider: PaymentProvider.PAYME,
          providerTransactionId: String(paymeId),
        },
      },
    });
  }

  /** Prisma's unique-constraint violation, raised by the racing CreateTransaction. */
  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }

  /**
   * Has this created-but-unperformed transaction outlived the 12-hour window?
   * Measured from the create time Payme assigned, against `now` (defaulting to
   * the current clock).
   */
  private isExpired(payment: Payment, now: number = Date.now()): boolean {
    if (payment.providerState !== PaymeState.CREATED) return false;
    const createdAt = Number(payment.providerCreateTime ?? 0);
    if (!createdAt) return false;
    return now - createdAt > PAYME_TRANSACTION_TIMEOUT_MS;
  }

  /**
   * Cancel a timed-out transaction with reason 4. Routed through
   * {@link SettlementService} so the order is released and an audit row written
   * exactly as for a Payme-initiated cancellation.
   */
  private async expire(payment: Payment): Promise<void> {
    await this.settlement.markCancelled(
      payment.id,
      PAYME_TIMEOUT_REASON,
      false,
    );
    this.logger.log(
      `Payme transaction ${payment.providerTransactionId} expired (12h timeout)`,
    );
  }

  /**
   * Expire an incumbent transaction from inside an open Prisma transaction.
   * Only the payment row is touched here; releasing the order is left to the
   * enclosing CreateTransaction, which is about to bind a fresh transaction to
   * that same still-PENDING_PAYMENT order.
   */
  private async expireInTx(
    tx: Prisma.TransactionClient,
    payment: Payment,
  ): Promise<void> {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.CANCELLED,
        providerState: PaymeState.CANCELLED,
        providerCancelTime: BigInt(Date.now()),
        cancelReason: PAYME_TIMEOUT_REASON,
      },
    });
    this.logger.log(
      `Payme transaction ${payment.providerTransactionId} expired (12h timeout) while creating a new one`,
    );
  }

  private async orderFromAccount(params: Record<string, any>) {
    const orderId = params.account?.[this.accountField];
    if (!orderId)
      throw new PaymeError(-31050, 'Order not found', this.accountField);
    const order = await this.prisma.order.findUnique({
      where: { id: String(orderId) },
    });
    if (!order)
      throw new PaymeError(-31050, 'Order not found', this.accountField);
    return order;
  }

  private assertAmount(
    totalUzs: { toString(): string },
    amountTiyin: unknown,
  ): void {
    const expected = Math.round(Number(totalUzs) * 100);
    if (Number(amountTiyin) !== expected) {
      throw new PaymeError(-31001, 'Incorrect amount');
    }
  }
}
