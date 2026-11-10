import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import {
  Payment,
  PaymentProvider,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MarkCancelledOutcome, SettlementService } from './settlement.service';
import { readPaymeConfig } from './payme.config';
import { isPayableOrderStatus } from '../order-transitions';
import { findUnavailableForPayment } from '../inventory/payment-availability';
import { OFFLINE_PAYMENT_TYPES } from '../offline-order.policy';
import { parseSetFiscalData } from './payme-fiscal-receipt.util';
import { PaymeFiscalReceiptService } from './payme-fiscal-receipt.service';
import { findOpenPaymeInvoice } from './payme-invoice.util';
import { FinanceAlerts } from '../finance-alerts';
import {
  paymeStatementQuery,
  presentStatementTransaction,
} from './payme-statement';

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
    /** Send `message` as a plain string, as SetFiscalData's contract shows it. */
    public plainMessage = false,
  ) {
    super(message);
  }
}
const L = (text: string) => ({ ru: text, uz: text, en: text });

/**
 * -32600: "required fields are missing or of the wrong type" (Payme's own
 * meaning of the JSON-RPC code). Raised BEFORE any lookup, so a malformed
 * request can never be coerced into a lookup key like the string "undefined".
 */
function invalidRequest(field: string): PaymeError {
  return new PaymeError(
    -32600,
    `Invalid or missing parameter: ${field}`,
    field,
  );
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const isInteger = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v);

/**
 * Minimum shape per method, as the Merchant API specifies it. Deliberately
 * lenient where the protocol is: a missing `account` keeps its account-level
 * answer (-31050), and a well-typed but WRONG amount keeps -31001 — only an
 * absent or mistyped field is a malformed request.
 */
function assertParams(method: string, params: unknown): Record<string, any> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalidRequest('params');
  }
  const p = params as Record<string, any>;
  const needsId = [
    'CreateTransaction',
    'PerformTransaction',
    'CancelTransaction',
    'CheckTransaction',
  ];
  if (needsId.includes(method) && !isNonEmptyString(p.id)) {
    throw invalidRequest('id');
  }
  if (
    (method === 'CheckPerformTransaction' || method === 'CreateTransaction') &&
    !(isInteger(p.amount) && p.amount > 0)
  ) {
    throw invalidRequest('amount');
  }
  if (
    method === 'CreateTransaction' &&
    p.time !== undefined &&
    !isInteger(p.time)
  ) {
    throw invalidRequest('time');
  }
  if (
    method === 'CancelTransaction' &&
    p.reason !== undefined &&
    p.reason !== null &&
    !isInteger(p.reason)
  ) {
    throw invalidRequest('reason');
  }
  if (method === 'GetStatement') {
    if (!isInteger(p.from)) throw invalidRequest('from');
    if (!isInteger(p.to)) throw invalidRequest('to');
  }
  return p;
}

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

/**
 * Has this created-but-unperformed transaction outlived the 12-hour window
 * (so Payme can no longer perform it)? Measured from the create time Payme
 * assigned, against `now` (defaulting to the current clock). Only a CREATED
 * (state 1) row can expire; a row without a create time never does.
 */
export function isPaymeTransactionExpired(
  payment: Pick<Payment, 'providerState' | 'providerCreateTime'>,
  now: number = Date.now(),
): boolean {
  if (payment.providerState !== PaymeState.CREATED) return false;
  const createdAt = Number(payment.providerCreateTime ?? 0);
  if (!createdAt) return false;
  return now - createdAt > PAYME_TRANSACTION_TIMEOUT_MS;
}

/** Payme cancellation reason for "transaction timed out". */
export const PAYME_TIMEOUT_REASON = 4;

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
    private readonly fiscalReceipts: PaymeFiscalReceiptService,
    @Optional() private readonly alerts?: FinanceAlerts,
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
          error: {
            code: err.code,
            message: err.plainMessage ? err.message : L(err.message),
            data: err.data,
          },
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

  private dispatch(method: string | undefined, raw: unknown) {
    const known = [
      'CheckPerformTransaction',
      'CreateTransaction',
      'PerformTransaction',
      'CancelTransaction',
      'CheckTransaction',
      'GetStatement',
      'SetFiscalData',
    ];
    if (!method || !known.includes(method)) {
      throw new PaymeError(-32601, 'Method not found');
    }
    // Validated on its own terms: this method answers -32602, naming the field.
    if (method === 'SetFiscalData') return this.setFiscalData(raw);
    const params = assertParams(method, raw);
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
    this.assertPayableOnline(order);
    if (!isPayableOrderStatus(order.status)) {
      throw new PaymeError(-31008, 'Order is not awaiting payment');
    }
    // One active (state 1) transaction per order — the same rule
    // CreateTransaction enforces, answered here with the same account-level
    // error so Payme hears a consistent "this order is already being paid"
    // before it ever tries to create a second transaction. An incumbent past
    // the 12-hour window does not count: CreateTransaction would expire it.
    const active = await this.prisma.payment.findFirst({
      where: {
        orderId: order.id,
        provider: PaymentProvider.PAYME,
        providerState: PaymeState.CREATED,
      },
    });
    if (active && !this.isExpired(active)) {
      throw new PaymeError(
        -31050,
        'Another transaction is in progress for this order',
        this.accountField,
      );
    }

    // Availability backstop (the checkout path refuses first — see
    // PaymentsService.createPaymeInvoice): never let Payme hold money for an
    // order whose parts went out of stock or whose dealer was suspended after
    // the link was issued. Checked here, BEFORE funds are held, and not at
    // PerformTransaction, where refusing would bounce a payment the customer
    // already confirmed.
    const unavailable = await findUnavailableForPayment(this.prisma, order.id);
    if (unavailable.length > 0) {
      throw new PaymeError(-31008, 'Order items are no longer available');
    }

    // Fiscalization. Payme takes the receipt from THIS reply, and it is the one frozen
    // when the invoice was created, so a change to the catalog since then cannot alter
    // what was agreed. Every Check for the invoice gives the same answer.
    const invoice = await this.invoiceOrRefuse(
      this.prisma,
      order.id,
      BigInt(params.amount),
    );

    return { allow: true, detail: invoice.fiscalSnapshot.detail };
  }

  /**
   * The open invoice a payment of this order would settle, or a refusal. There is no
   * receipt without one, and a receipt is never built here for Payme to hold: no
   * invoice (a link already used and cancelled, or one past its window) means the
   * customer starts the payment again, which re-checks the fiscal data and freezes a
   * receipt from what it says by then. A receipt that no longer adds up to the amount
   * is refused rather than sent: sending malformed fiscal data is worse than a failed
   * payment.
   */
  private async invoiceOrRefuse(
    client: Pick<Prisma.TransactionClient, 'payment'>,
    orderId: string,
    amountTiyin: bigint,
  ) {
    const invoice = await findOpenPaymeInvoice(client, orderId);
    const receipt = invoice?.fiscalSnapshot;
    if (!invoice || !receipt) {
      this.logger.warn(
        `Order ${orderId} has no open Payme invoice: the customer has to start the payment again`,
      );
      throw new PaymeError(-31008, 'Order cannot be fiscalized');
    }
    if (receipt.totalTiyin !== amountTiyin) {
      this.logger.error(
        `Invoice ${invoice.id} holds a receipt of ${receipt.totalTiyin} tiyin, and Payme asked about ${amountTiyin}`,
      );
      throw new PaymeError(-31008, 'Order cannot be fiscalized');
    }
    return { ...invoice, fiscalSnapshot: receipt };
  }

  /**
   * Payme reporting a fiscal receipt it registered. Authorized like every other method.
   * A malformed call is refused, naming the field; anything well-formed about a known
   * transaction is success, including a repeat and a conflict, because the conflict is
   * ours to reconcile and answering an error would only have Payme try again.
   */
  private async setFiscalData(raw: unknown) {
    const parsed = parseSetFiscalData(raw);
    if (!parsed.ok) {
      throw new PaymeError(-32602, parsed.invalid, undefined, true);
    }
    const outcome = await this.fiscalReceipts.record(parsed.callback);
    if (outcome === 'not_found') {
      throw new PaymeError(-32001, 'Чек с таким id не найден', undefined, true);
    }
    return { success: true };
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
    this.assertPayableOnline(order);
    if (!isPayableOrderStatus(order.status)) {
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
        }

        // Re-check the order UNDER the lock: the status read above happened
        // before it, so an operator could have cancelled the order in between.
        // Binding a new transaction to a no-longer-payable order would hand
        // Payme a payable account that settlement then refuses.
        const locked = await tx.order.findUnique({
          where: { id: order.id },
          select: { status: true },
        });
        if (!locked || !isPayableOrderStatus(locked.status)) {
          throw new PaymeError(-31008, 'Order is not awaiting payment');
        }

        if (active) {
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

        // The last gate before funds are held. The transaction takes the invoice whose
        // receipt Check handed over, under the lock a new invoice needs too, so that
        // receipt is what it stays bound to. With no such invoice it is refused: a
        // transaction with no receipt on file could never be reconciled.
        const invoice = await this.invoiceOrRefuse(tx, order.id, amountTiyin);
        return tx.payment.update({
          where: { id: invoice.id },
          data: {
            providerTransactionId: paymeId,
            providerState: PaymeState.CREATED,
            providerCreateTime: BigInt(createTime),
            amountTiyin,
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
    // `paid_meanwhile`: a concurrent Perform settled it first, so settlement below
    // is a no-op and the reply reports what the database holds.
    if (
      this.isExpired(payment) &&
      (await this.expire(payment)) !== 'paid_meanwhile'
    ) {
      throw new PaymeError(-31008, 'Transaction timed out');
    }

    const performTime = Date.now();
    const outcome = await this.settlement.markPaid(payment.id, performTime);
    if (outcome === 'order_not_payable') {
      // The order left PENDING_PAYMENT (cancelled by an operator, …) while the
      // transaction was open. Refuse: Payme then cancels the transaction and
      // the customer is not charged. Nothing was written on our side.
      throw new PaymeError(-31008, 'Order is not awaiting payment');
    }
    // Re-read so the reply carries the persisted timestamp: if a concurrent
    // Perform settled first, markPaid was a no-op and the stored value — not
    // ours — is the one Payme must keep seeing.
    const settled = await this.byPaymeId(params.id);
    if (settled?.providerState !== PaymeState.PERFORMED) {
      // Not settled by us nor by a concurrent Perform (e.g. cancelled in
      // between) — never report a state-2 that the database does not hold.
      throw new PaymeError(-31008, 'Transaction cannot be performed');
    }
    return {
      transaction: payment.id,
      perform_time: Number(settled.providerPerformTime ?? performTime),
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

    // Which branch to try comes from the read above, which may already be stale.
    // What decides is the conditional claim inside settlement, so a Perform that
    // committed since the read cannot be overwritten: the attempt reports
    // `paid_meanwhile` and the cancellation is handled as the refund it now is.
    const performed = payment.providerState === PaymeState.PERFORMED;
    let outcome = await this.settlement.markCancelled(
      payment.id,
      reason ?? undefined,
      performed,
    );
    if (outcome === 'paid_meanwhile') {
      outcome = await this.settlement.markCancelled(
        payment.id,
        reason ?? undefined,
        true,
      );
    }

    // A refund is only possible while the goods have not been handed over.
    if (outcome === 'not_refundable') {
      // The buyer asked for their money back through Payme and it was refused: someone has
      // to take it up by hand, through the refund registry, before the buyer chases it.
      // A refund the buyer wants and Payme could not make is a return under way: sellers are
      // not paid for this order until an operator settles it and releases the hold.
      await this.prisma.order.updateMany({
        where: { id: payment.orderId, payoutHoldAt: null },
        data: {
          payoutHoldAt: new Date(),
          payoutHoldReason:
            'Payme asked for a refund after the goods were handed over, and it was refused.',
        },
      });
      this.alerts?.raise({
        type: 'refund_refused',
        severity: 'critical',
        message: `Payme asked to refund payment ${payment.id} (order ${payment.orderId}), and it was refused: the order was handed over.`,
        context: {
          paymentId: payment.id,
          orderId: payment.orderId,
          transactionId: payment.providerTransactionId,
          reason,
        },
      });
      throw new PaymeError(
        -31007,
        'Order has been delivered. Transaction cannot be cancelled',
      );
    }
    if (outcome === 'not_cancellable' || outcome === 'not_found') {
      throw new PaymeError(-31008, 'Transaction cannot be cancelled');
    }
    return this.reportCancelled(
      payment.id,
      performed ? PaymeState.CANCELLED_AFTER_PERFORM : PaymeState.CANCELLED,
    );
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

  /**
   * Every transaction Payme created in the window, whatever became of it, oldest first: the
   * Merchant API asks for them in order of creation, and Payme reconciles against this list.
   * An invoice no transaction took has no create time, so it is not among them.
   */
  private async getStatement(params: Record<string, any>) {
    const from = BigInt(Number(params.from ?? 0));
    const to = BigInt(Number(params.to ?? Date.now()));
    const payments = await this.prisma.payment.findMany(
      paymeStatementQuery(from, to),
    );
    return {
      transactions: payments.map((p) =>
        presentStatementTransaction(p, this.accountField),
      ),
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

  /** See {@link isPaymeTransactionExpired}. */
  private isExpired(payment: Payment, now: number = Date.now()): boolean {
    return isPaymeTransactionExpired(payment, now);
  }

  /**
   * Cancel a timed-out transaction with reason 4. Routed through
   * {@link SettlementService} so the order is released and an audit row written
   * exactly as for a Payme-initiated cancellation.
   */
  private async expire(payment: Payment): Promise<MarkCancelledOutcome> {
    const outcome = await this.settlement.markCancelled(
      payment.id,
      PAYME_TIMEOUT_REASON,
      false,
    );
    this.logger.log(
      `Payme transaction ${payment.providerTransactionId} expired (12h timeout)`,
    );
    return outcome;
  }

  /**
   * Expire an incumbent transaction from inside an open Prisma transaction.
   * Only the payment row is touched here; releasing the order is left to the
   * enclosing CreateTransaction, which is about to bind a fresh transaction to
   * that same still-PENDING_PAYMENT order. From PENDING only, like every other
   * path that cancels an unperformed payment.
   */
  private async expireInTx(
    tx: Prisma.TransactionClient,
    payment: Payment,
  ): Promise<void> {
    await tx.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
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

  /** A cash or terminal order is settled in person; see PaymentsService. */
  private assertPayableOnline(order: { paymentType: PaymentType | null }): void {
    if (order.paymentType && OFFLINE_PAYMENT_TYPES.includes(order.paymentType)) {
      throw new PaymeError(-31008, 'Order is not paid online');
    }
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
