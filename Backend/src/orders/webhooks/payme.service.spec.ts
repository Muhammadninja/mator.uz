/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Payme Merchant API conformance suite.
 *
 * Covers the scenarios the Payme sandbox (test.paycom.uz) exercises plus the
 * race and failure modes the integration audit flagged: duplicate and concurrent
 * CreateTransaction, the 12-hour timeout, idempotent Perform/Cancel with stored
 * timestamps, refund refusal after delivery, malformed JSON, and settlement
 * rollback.
 */
import { OrderStatus, Prisma } from '@prisma/client';
import {
  PaymeService,
  PAYME_TRANSACTION_TIMEOUT_MS,
  PAYME_TIMEOUT_REASON,
} from './payme.service';
import {
  createPrismaMock,
  fakeConfig,
  FROZEN_RECEIPT,
  buildOrder,
  openPaymeInvoice,
  PrismaMock,
  stubFiscalizableOrderLines,
  stubOpenPaymeInvoice,
} from '../../../test/utils/harness';
import { PaymeFiscalReceiptService } from './payme-fiscal-receipt.service';
import { SettlementService } from './settlement.service';
import { OrderStatusService } from '../order-status.service';
import {
  order,
  pendingPaymePayment,
  settlementStore,
} from './settlement-store.test-util';

const KEY = 'merchant-secret';
const AUTH = 'Basic ' + Buffer.from(`Paycom:${KEY}`).toString('base64');
const CONFIG = fakeConfig({
  PAYME_MERCHANT_KEY: KEY,
  PAYME_MERCHANT_ID: 'merchant-1',
  PAYME_ACCOUNT_FIELD: 'order_id',
});

/**
 * A payment row as the service reads it. `providerCreateTime` defaults to "just
 * now" because the 12-hour timeout is measured against the wall clock — a fixed
 * past timestamp would make every state-1 row read as expired. Tests that want
 * an expired row set it explicitly.
 */
function buildPayment(over: Partial<any> = {}): any {
  return {
    id: 'pay_1',
    orderId: 'ord_1',
    provider: 'PAYME',
    status: 'PENDING',
    amountUzs: 215000,
    amountTiyin: BigInt(21_500_000),
    providerTransactionId: 'pmt-xyz',
    providerState: 1,
    providerCreateTime: BigInt(Date.now()),
    providerPerformTime: null,
    providerCancelTime: null,
    cancelReason: null,
    ...over,
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('PaymeService (Merchant API)', () => {
  let prisma: PrismaMock;
  let settlement: { markPaid: jest.Mock; markCancelled: jest.Mock };
  let svc: PaymeService;

  beforeEach(() => {
    prisma = createPrismaMock();
    settlement = {
      markPaid: jest.fn().mockResolvedValue(undefined),
      markCancelled: jest.fn().mockResolvedValue(undefined),
    };
    svc = new PaymeService(
      prisma,
      CONFIG as any,
      settlement as any,
      new PaymeFiscalReceiptService(prisma as any),
    );
    // A fully fiscalizable order unless a test says otherwise, so each protocol test
    // is about the protocol.
    stubFiscalizableOrderLines(prisma);
    stubOpenPaymeInvoice(prisma);
  });

  // Any test that freezes the clock must not leak fake timers into the next one.
  afterEach(() => {
    jest.useRealTimers();
  });

  // `auth` accepts null to mean "send no Authorization header at all"; a default
  // parameter cannot express that, since `undefined` would select the default.
  const call = (
    method: string,
    params: Record<string, any> = {},
    auth: string | null = AUTH,
  ) => svc.handle(auth ?? undefined, { id: 1, method, params }) as Promise<any>;

  // ── authentication ─────────────────────────────────────────────────────────
  describe('authentication', () => {
    it('rejects a wrong merchant key with -32504', async () => {
      const res = await call('CheckPerformTransaction', {}, 'Basic wrong');
      expect(res.error.code).toBe(-32504);
    });

    it('rejects a missing Authorization header with -32504', async () => {
      const res = await call('CheckPerformTransaction', {}, null);
      expect(res.error.code).toBe(-32504);
    });

    it('refuses every caller when no merchant key is configured', async () => {
      const keyless = new PaymeService(
        prisma,
        fakeConfig({}) as any,
        settlement as any,
        new PaymeFiscalReceiptService(prisma as any),
      );
      // The header that an empty key would otherwise make valid.
      const emptyKeyAuth = 'Basic ' + Buffer.from('Paycom:').toString('base64');
      const res: any = await keyless.handle(emptyKeyAuth, {
        id: 1,
        method: 'CheckTransaction',
        params: {},
      });
      expect(res.error.code).toBe(-32504);
    });

    it('rejects an unknown method with -32601', async () => {
      const res = await call('NoSuchMethod');
      expect(res.error.code).toBe(-32601);
    });
  });

  // ── malformed JSON ─────────────────────────────────────────────────────────
  describe('malformed JSON', () => {
    it('answers -32700 for an unparseable body', async () => {
      const res: any = await svc.handleRaw(AUTH, '{"method": broken');
      expect(res.error.code).toBe(-32700);
      expect(res.id).toBeNull();
    });

    it('answers -32700 for an empty body', async () => {
      const res: any = await svc.handleRaw(AUTH, '');
      expect(res.error.code).toBe(-32700);
    });

    it('parses a valid raw JSON string normally', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      const res: any = await svc.handleRaw(
        AUTH,
        JSON.stringify({
          id: 7,
          method: 'CheckPerformTransaction',
          params: { account: { order_id: 'ord_1' }, amount: 21_500_000 },
        }),
      );
      expect(res.result.allow).toBe(true);
      expect(res.id).toBe(7);
    });
  });

  // ── CheckPerformTransaction ────────────────────────────────────────────────
  describe('CheckPerformTransaction', () => {
    it('allows a payable order', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      const res = await call('CheckPerformTransaction', {
        account: { order_id: 'ord_1' },
        amount: 21_500_000,
      });
      expect(res.result.allow).toBe(true);
      expect(res.result.detail.items).toHaveLength(3);
    });

    it('rejects a wrong amount with -31001', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      const res = await call('CheckPerformTransaction', {
        account: { order_id: 'ord_1' },
        amount: 999,
      });
      expect(res.error.code).toBe(-31001);
    });

    it('rejects an unknown order with -31050 naming the account field', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      const res = await call('CheckPerformTransaction', {
        account: { order_id: 'nope' },
        amount: 21_500_000,
      });
      expect(res.error.code).toBe(-31050);
      expect(res.error.data).toBe('order_id');
    });

    it('rejects a missing account field with -31050', async () => {
      const res = await call('CheckPerformTransaction', {
        account: {},
        amount: 21_500_000,
      });
      expect(res.error.code).toBe(-31050);
    });

    it('rejects an already-paid order', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', status: 'PAID', totalUzs: 215000 }),
      );
      const res = await call('CheckPerformTransaction', {
        account: { order_id: 'ord_1' },
        amount: 21_500_000,
      });
      expect(res.error.code).toBe(-31008);
    });

    // ── Фискализация ──────────────────────────────────────────────────────
    // Payme takes the receipt from this reply, so the items are attached here.
    it('hands over the receipt frozen on the invoice, alongside allow', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );

      const res = await call('CheckPerformTransaction', {
        account: { order_id: 'ord_1' },
        amount: 21_500_000,
      });

      expect(res.result).toEqual({ allow: true, detail: FROZEN_RECEIPT });
      // The receipt adds up to exactly the amount being authorised.
      const sum = res.result.detail.items.reduce(
        (t: number, i: any) => t + i.price * i.count,
        0,
      );
      expect(sum).toBe(21_500_000);
    });

    describe('what was agreed does not move', () => {
      const CHECK = {
        account: { order_id: 'ord_1' },
        amount: 21_500_000,
      };
      beforeEach(() => {
        prisma.order.findUnique.mockResolvedValue(
          buildOrder({ id: 'ord_1', totalUzs: 215000 }),
        );
      });

      it('ignores a catalog that changed since the invoice: another MXIK, VAT, dealer', async () => {
        prisma.catalogPart.findMany.mockResolvedValue([
          {
            id: 'part_1',
            inStock: true,
            priceUzs: 185000,
            packageForm: 'SET',
            kind: 'SPARE_PART',
            oilType: null,
            category: { id: 'moved', mxik: '00000000000000000' },
            seller: { status: 'ACTIVE', tin: '999999999', vatPercent: 12 },
          },
        ]);

        const res = await call('CheckPerformTransaction', CHECK);

        expect(res.result.detail).toEqual(FROZEN_RECEIPT);
      });

      it('still allows when the data has since become incomplete', async () => {
        prisma.catalogPart.findMany.mockResolvedValue([
          {
            id: 'part_1',
            inStock: true,
            priceUzs: 185000,
            category: null,
            seller: { status: 'ACTIVE', tin: null, vatPercent: null },
          },
        ]);

        const res = await call('CheckPerformTransaction', CHECK);

        expect(res.result.allow).toBe(true);
      });

      it('answers every Check for the invoice the same', async () => {
        const first = await call('CheckPerformTransaction', CHECK);
        const second = await call('CheckPerformTransaction', CHECK);
        expect(second.result).toEqual(first.result);
      });

      it('still refuses parts that went out of stock: availability is a live fact', async () => {
        prisma.catalogPart.findMany.mockResolvedValue([
          {
            id: 'part_1',
            inStock: false,
            priceUzs: 185000,
            seller: { status: 'ACTIVE' },
          },
        ]);

        const res = await call('CheckPerformTransaction', CHECK);

        expect(res.error.code).toBe(-31008);
      });

      it('builds nothing itself: there is no receipt without an invoice', async () => {
        prisma.payment.findFirst.mockResolvedValue(null);

        const res = await call('CheckPerformTransaction', CHECK);

        expect(res.error.code).toBe(-31008);
        expect(res.result).toBeUndefined();
      });

      it('refuses a receipt that no longer adds up to the amount, rather than send it', async () => {
        stubOpenPaymeInvoice(
          prisma,
          openPaymeInvoice({
            fiscalSnapshot: {
              paymentId: 'pay_invoice',
              detail: FROZEN_RECEIPT,
              totalTiyin: BigInt(21_500_001),
            },
          }),
        );

        const res = await call('CheckPerformTransaction', CHECK);

        expect(res.error.code).toBe(-31008);
        expect(res.result).toBeUndefined();
      });

      it('looks only at an invoice no transaction has taken, in its window, with a receipt', async () => {
        await call('CheckPerformTransaction', CHECK);

        const lookup = prisma.payment.findFirst.mock.calls
          .map(([args]: any[]) => args)
          .find((args: any) => args.where.providerTransactionId === null);
        expect(lookup.where).toEqual({
          orderId: 'ord_1',
          provider: 'PAYME',
          providerTransactionId: null,
          status: 'PENDING',
          fiscalSnapshot: { isNot: null },
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        });
        expect(lookup.orderBy).toEqual({ createdAt: 'desc' });
      });
    });
  });

  // ── SetFiscalData ──────────────────────────────────────────────────────────
  describe('SetFiscalData', () => {
    const PARAMS = {
      id: 'pmt-xyz',
      type: 'PERFORM',
      fiscal_data: { receipt_id: 121, status_code: 0, message: 'accepted' },
    };

    it('is on the list of methods, and answers { success: true }', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'pay_1',
        providerState: 2,
      });
      prisma.paymeFiscalReceipt.findUnique.mockResolvedValue(null);

      const res = await call('SetFiscalData', PARAMS);

      expect(res.result).toEqual({ success: true });
      expect(prisma.paymeFiscalReceipt.create).toHaveBeenCalledTimes(1);
    });

    it('is authorized like every other method', async () => {
      const res = await call('SetFiscalData', PARAMS, 'Basic wrong');
      expect(res.error.code).toBe(-32504);
      expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    });

    it('-32001 with a plain message for an unknown check', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      const res = await call('SetFiscalData', PARAMS);
      expect(res.error).toEqual({
        code: -32001,
        message: 'Чек с таким id не найден',
      });
    });

    it('-32602 naming the parameter in a plain message, before any lookup', async () => {
      const res = await call('SetFiscalData', { ...PARAMS, type: 'REFUND' });
      expect(res.error).toEqual({ code: -32602, message: 'type' });
      expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    });

    it('-32602 for params that are no object, rather than -32600', async () => {
      const res: any = await svc.handle(AUTH, {
        id: 1,
        method: 'SetFiscalData',
        params: 'nope' as never,
      });
      expect(res.error).toEqual({ code: -32602, message: 'params' });
    });

    it('a database failure is -32400, with no internal message', async () => {
      prisma.payment.findUnique.mockRejectedValue(new Error('secret detail'));
      const res = await call('SetFiscalData', PARAMS);
      expect(res.error.code).toBe(-32400);
      expect(JSON.stringify(res)).not.toContain('secret detail');
    });

    it('leaves the message of every other method localized', async () => {
      const res = await call('CheckTransaction', { id: 'pmt-unknown' });
      expect(res.error.message).toEqual(
        expect.objectContaining({ ru: expect.any(String) }),
      );
    });
  });

  // ── CreateTransaction ──────────────────────────────────────────────────────
  describe('CreateTransaction', () => {
    const params = {
      id: 'pmt-xyz',
      time: 1_700_000_000_000,
      amount: 21_500_000,
      account: { order_id: 'ord_1' },
    };

    it('creates a transaction in state 1, on the invoice', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      // The persisted row carries the create time Payme sent, which is what the
      // reply echoes back.
      prisma.payment.update.mockResolvedValue(
        buildPayment({
          id: 'pay_invoice',
          providerCreateTime: BigInt(params.time),
        }),
      );

      const res = await call('CreateTransaction', params);
      expect(res.result).toEqual({
        create_time: 1_700_000_000_000,
        transaction: 'pay_invoice',
        state: 1,
      });
      // Payme's clock is authoritative for create_time — we persist what it sent.
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay_invoice' },
        data: {
          providerTransactionId: 'pmt-xyz',
          providerState: 1,
          providerCreateTime: BigInt(params.time),
          amountTiyin: BigInt(21_500_000),
        },
      });
      // The receipt it took stays the invoice's: nothing is written to it.
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('opens no transaction with no invoice to take: no receipt would be on file', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      prisma.payment.findFirst.mockResolvedValue(null);

      const res = await call('CreateTransaction', params);

      expect(res.error.code).toBe(-31008);
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('opens no transaction on a receipt that does not add up to the amount', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      stubOpenPaymeInvoice(
        prisma,
        openPaymeInvoice({
          fiscalSnapshot: {
            paymentId: 'pay_invoice',
            detail: FROZEN_RECEIPT,
            totalTiyin: BigInt(100),
          },
        }),
      );

      const res = await call('CreateTransaction', params);

      expect(res.error.code).toBe(-31008);
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('does not read the catalog: the receipt was settled when the invoice was made', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      prisma.payment.update.mockResolvedValue(
        buildPayment({ id: 'pay_invoice' }),
      );
      prisma.catalogPart.findMany.mockClear();
      prisma.orderItem.findMany.mockClear();

      const res = await call('CreateTransaction', params);

      expect(res.result.transaction).toBe('pay_invoice');
      expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
    });

    it('is idempotent: a duplicate request returns the stored create_time', async () => {
      const stored = buildPayment();
      prisma.payment.findUnique.mockResolvedValue(stored);
      const res = await call('CreateTransaction', params);
      expect(res.result).toEqual({
        create_time: Number(stored.providerCreateTime),
        transaction: 'pay_1',
        state: 1,
      });
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('concurrent create with the SAME id: the P2002 loser reports the winner row', async () => {
      // Nothing on the first read; the unique index rejects our write because a
      // parallel request won, and the re-read then finds the winner.
      const winner = buildPayment({ id: 'pay_winner' });
      prisma.payment.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      prisma.payment.update.mockRejectedValue(uniqueViolation());

      const res = await call('CreateTransaction', params);
      expect(res.result).toEqual({
        create_time: Number(winner.providerCreateTime),
        transaction: 'pay_winner',
        state: 1,
      });
    });

    it('concurrent create with a DIFFERENT id for the same order is refused in the account-error range', async () => {
      // Regression (Payme sandbox, "CreateTransaction while the account is
      // busy"): this used to answer -31008, which the sandbox rejects. An order
      // already held by another active transaction is an ACCOUNT-level refusal,
      // so the code must land in -31099..-31050 and name the account field in
      // `data`. Asserting the range — not just the literal — is deliberate:
      // that is exactly what the sandbox checks.
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      // An active transaction already exists for this order.
      prisma.payment.findFirst.mockResolvedValue(
        buildPayment({ providerTransactionId: 'pmt-other' }),
      );

      const res = await call('CreateTransaction', {
        ...params,
        id: 'pmt-second',
      });
      expect(res.error.code).toBeGreaterThanOrEqual(-31099);
      expect(res.error.code).toBeLessThanOrEqual(-31050);
      expect(res.error.code).toBe(-31050);
      expect(res.error.data).toBe('order_id');
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('reports the duplicate idempotently when the active transaction IS this one', async () => {
      // Regression: a duplicate CreateTransaction that waited on the order row
      // lock used to see the winner's row, treat it as a competitor and answer
      // -31008 — so two concurrent identical calls got different answers. The
      // active row must be compared by transaction id before being refused.
      const winner = buildPayment({
        id: 'pay_winner',
        providerCreateTime: BigInt(1_600_000_000_000),
      });
      prisma.payment.findUnique.mockResolvedValue(null); // not visible on first read
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      // After the lock is released, the winner's row is now visible.
      prisma.payment.findFirst.mockResolvedValue(winner);

      const res = await call('CreateTransaction', params);

      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({
        create_time: 1_600_000_000_000, // the STORED time, not our local one
        transaction: 'pay_winner',
        state: 1,
      });
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('locks the order row before checking for an active transaction', async () => {
      // Without SELECT … FOR UPDATE two concurrent creators would both read "no
      // active transaction" under READ COMMITTED and both insert. The lock is
      // what makes the check-then-insert atomic, so assert it is taken.
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      prisma.payment.update.mockResolvedValue(buildPayment());

      await call('CreateTransaction', params);

      const sql = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as string[];
      expect(sql.join('?')).toMatch(
        /SELECT id FROM orders WHERE id = \? FOR UPDATE/,
      );
    });

    it('rejects a wrong amount with -31001', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      const res = await call('CreateTransaction', { ...params, amount: 1 });
      expect(res.error.code).toBe(-31001);
    });

    it('rejects an unknown order with -31050', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(null);
      const res = await call('CreateTransaction', params);
      expect(res.error.code).toBe(-31050);
    });

    it('refuses to re-create a transaction that is in a final state', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({ providerState: 2 }),
      );
      const res = await call('CreateTransaction', params);
      expect(res.error.code).toBe(-31008);
    });

    it('expires an incumbent transaction older than 12h and creates the new one', async () => {
      const stale = buildPayment({
        id: 'pay_stale',
        providerTransactionId: 'pmt-old',
        providerCreateTime: BigInt(
          params.time - PAYME_TRANSACTION_TIMEOUT_MS - 1,
        ),
      });
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      prisma.payment.findFirst
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(openPaymeInvoice());
      prisma.payment.update.mockResolvedValue(
        buildPayment({ id: 'pay_invoice' }),
      );

      const res = await call('CreateTransaction', params);
      expect(res.result.state).toBe(1);
      // The stale row is cancelled with the timeout reason, from PENDING only.
      expect(prisma.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pay_stale', status: 'PENDING' },
          data: expect.objectContaining({
            providerState: -1,
            cancelReason: PAYME_TIMEOUT_REASON,
          }),
        }),
      );
    });

    it('reports a timed-out transaction as un-performable on a repeat create', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({
          providerCreateTime: BigInt(
            Date.now() - PAYME_TRANSACTION_TIMEOUT_MS - 1,
          ),
        }),
      );
      const res = await call('CreateTransaction', params);
      expect(res.error.code).toBe(-31008);
      expect(settlement.markCancelled).toHaveBeenCalledWith(
        'pay_1',
        PAYME_TIMEOUT_REASON,
        false,
      );
    });
  });

  // ── PerformTransaction ─────────────────────────────────────────────────────
  describe('PerformTransaction', () => {
    it('settles a created transaction and returns state 2', async () => {
      prisma.payment.findUnique
        .mockResolvedValueOnce(
          buildPayment({ providerCreateTime: BigInt(Date.now()) }),
        )
        .mockResolvedValueOnce(
          buildPayment({
            providerState: 2,
            providerPerformTime: BigInt(1_700_000_111_000),
          }),
        );

      const res = await call('PerformTransaction', { id: 'pmt-xyz' });
      expect(res.result).toEqual({
        transaction: 'pay_1',
        perform_time: 1_700_000_111_000,
        state: 2,
      });
      expect(settlement.markPaid).toHaveBeenCalledWith(
        'pay_1',
        expect.any(Number),
      );
    });

    it('builds no receipt and reads no price: the stored order is what was agreed', async () => {
      prisma.payment.findUnique
        .mockResolvedValueOnce(buildPayment())
        .mockResolvedValueOnce(buildPayment({ providerState: 2 }));
      prisma.catalogPart.findMany.mockClear();
      prisma.orderItem.findMany.mockClear();

      await call('PerformTransaction', { id: 'pmt-xyz' });

      expect(settlement.markPaid).toHaveBeenCalled();
      expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('is idempotent: a repeat returns the STORED perform_time and does not re-settle', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({
          providerState: 2,
          providerPerformTime: BigInt(1_700_000_111_000),
        }),
      );

      const first = await call('PerformTransaction', { id: 'pmt-xyz' });
      const second = await call('PerformTransaction', { id: 'pmt-xyz' });

      expect(first.result.perform_time).toBe(1_700_000_111_000);
      expect(second.result).toEqual(first.result);
      expect(settlement.markPaid).not.toHaveBeenCalled();
    });

    it('rejects an unknown transaction with -31003', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      const res = await call('PerformTransaction', { id: 'nope' });
      expect(res.error.code).toBe(-31003);
    });

    it('refuses to perform a cancelled transaction with -31008', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({ providerState: -1 }),
      );
      const res = await call('PerformTransaction', { id: 'pmt-xyz' });
      expect(res.error.code).toBe(-31008);
      expect(settlement.markPaid).not.toHaveBeenCalled();
    });

    it('refuses a transaction past the 12h timeout and cancels it with reason 4', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({
          providerCreateTime: BigInt(
            Date.now() - PAYME_TRANSACTION_TIMEOUT_MS - 1,
          ),
        }),
      );
      const res = await call('PerformTransaction', { id: 'pmt-xyz' });
      expect(res.error.code).toBe(-31008);
      expect(settlement.markCancelled).toHaveBeenCalledWith(
        'pay_1',
        PAYME_TIMEOUT_REASON,
        false,
      );
      expect(settlement.markPaid).not.toHaveBeenCalled();
    });

    it('still confirms a transaction created exactly at the timeout boundary', async () => {
      // The clock must be frozen: the window is checked with a strict `>`, so a
      // few milliseconds elapsing between the fixture and the check would push
      // an exactly-at-the-limit transaction over it and make this flaky.
      jest.useFakeTimers().setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
      const now = Date.now();
      prisma.payment.findUnique
        .mockResolvedValueOnce(
          buildPayment({
            providerCreateTime: BigInt(now - PAYME_TRANSACTION_TIMEOUT_MS),
          }),
        )
        .mockResolvedValueOnce(
          buildPayment({ providerState: 2, providerPerformTime: BigInt(now) }),
        );
      const res = await call('PerformTransaction', { id: 'pmt-xyz' });
      jest.useRealTimers();
      expect(res.result.state).toBe(2);
    });

    it('a concurrent perform that already settled wins: the stored time is returned', async () => {
      // Our markPaid is a no-op because a parallel call settled first; the
      // re-read must surface THAT timestamp, not our local clock.
      prisma.payment.findUnique
        .mockResolvedValueOnce(
          buildPayment({ providerCreateTime: BigInt(Date.now()) }),
        )
        .mockResolvedValueOnce(
          buildPayment({
            providerState: 2,
            providerPerformTime: BigInt(1_699_999_000_000),
          }),
        );

      const res = await call('PerformTransaction', { id: 'pmt-xyz' });
      expect(res.result.perform_time).toBe(1_699_999_000_000);
    });

    it('reports -32400 when settlement fails, leaving the transaction unperformed', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({ providerCreateTime: BigInt(Date.now()) }),
      );
      settlement.markPaid.mockRejectedValue(new Error('db write failed'));

      const res = await call('PerformTransaction', { id: 'pmt-xyz' });
      expect(res.error.code).toBe(-32400);
      // The internal message must not leak to Payme.
      expect(JSON.stringify(res)).not.toContain('db write failed');
    });
  });

  // ── CancelTransaction ──────────────────────────────────────────────────────
  describe('CancelTransaction', () => {
    it('cancels a created transaction to state -1', async () => {
      prisma.payment.findUnique
        .mockResolvedValueOnce(buildPayment())
        .mockResolvedValueOnce(
          buildPayment({
            providerState: -1,
            providerCancelTime: BigInt(1_700_000_222_000),
          }),
        );

      const res = await call('CancelTransaction', { id: 'pmt-xyz', reason: 3 });
      expect(res.result).toEqual({
        transaction: 'pay_1',
        cancel_time: 1_700_000_222_000,
        state: -1,
      });
      expect(settlement.markCancelled).toHaveBeenCalledWith('pay_1', 3, false);
    });

    it('refunds a performed transaction to state -2', async () => {
      prisma.payment.findUnique
        .mockResolvedValueOnce(buildPayment({ providerState: 2 }))
        .mockResolvedValueOnce(
          buildPayment({
            providerState: -2,
            providerCancelTime: BigInt(1_700_000_333_000),
          }),
        );
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', status: 'PAID' }),
      );

      const res = await call('CancelTransaction', { id: 'pmt-xyz', reason: 5 });
      expect(res.result.state).toBe(-2);
      expect(settlement.markCancelled).toHaveBeenCalledWith('pay_1', 5, true);
    });

    it('answers -31007 when settlement finds the goods handed over', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({ providerState: 2 }),
      );
      settlement.markCancelled.mockResolvedValue('not_refundable');

      const res = await call('CancelTransaction', { id: 'pmt-xyz', reason: 5 });
      expect(res.error.code).toBe(-31007);
      expect(settlement.markCancelled).toHaveBeenCalledWith('pay_1', 5, true);
    });

    it('handles as a refund a Perform that committed after the read', async () => {
      prisma.payment.findUnique
        .mockResolvedValueOnce(buildPayment())
        .mockResolvedValueOnce(
          buildPayment({
            providerState: -2,
            providerCancelTime: BigInt(1_700_000_333_000),
          }),
        );
      settlement.markCancelled
        .mockResolvedValueOnce('paid_meanwhile')
        .mockResolvedValueOnce('refunded');

      const res = await call('CancelTransaction', { id: 'pmt-xyz', reason: 3 });

      expect(res.result).toEqual({
        transaction: 'pay_1',
        cancel_time: 1_700_000_333_000,
        state: -2,
      });
      expect(settlement.markCancelled.mock.calls).toEqual([
        ['pay_1', 3, false],
        ['pay_1', 3, true],
      ]);
    });

    it('answers -31008 for a payment no branch can cancel, never a cancelled state', async () => {
      prisma.payment.findUnique.mockResolvedValue(buildPayment());
      settlement.markCancelled.mockResolvedValue('not_cancellable');

      const res = await call('CancelTransaction', { id: 'pmt-xyz', reason: 3 });

      expect(res.error.code).toBe(-31008);
    });

    it('is idempotent: a repeat returns the STORED cancel_time without re-cancelling', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({
          providerState: -1,
          providerCancelTime: BigInt(1_700_000_222_000),
          cancelReason: 3,
        }),
      );

      const first = await call('CancelTransaction', {
        id: 'pmt-xyz',
        reason: 3,
      });
      const second = await call('CancelTransaction', {
        id: 'pmt-xyz',
        reason: 3,
      });

      expect(first.result).toEqual({
        transaction: 'pay_1',
        cancel_time: 1_700_000_222_000,
        state: -1,
      });
      expect(second.result).toEqual(first.result);
      expect(settlement.markCancelled).not.toHaveBeenCalled();
    });

    it('rejects an unknown transaction with -31003', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      const res = await call('CancelTransaction', { id: 'nope', reason: 1 });
      expect(res.error.code).toBe(-31003);
    });
  });

  // ── CheckTransaction ───────────────────────────────────────────────────────
  describe('CheckTransaction', () => {
    it('reports the stored timestamps and state', async () => {
      const stored = buildPayment({
        providerState: 2,
        providerCreateTime: BigInt(1_700_000_000_000),
        providerPerformTime: BigInt(1_700_000_111_000),
        cancelReason: null,
      });
      prisma.payment.findUnique.mockResolvedValue(stored);
      const res = await call('CheckTransaction', { id: 'pmt-xyz' });
      expect(res.result).toEqual({
        create_time: 1_700_000_000_000,
        perform_time: 1_700_000_111_000,
        cancel_time: 0,
        transaction: 'pay_1',
        state: 2,
        reason: null,
      });
    });

    it('matches the timestamps PerformTransaction reported (no drift)', async () => {
      const performed = buildPayment({
        providerState: 2,
        providerPerformTime: BigInt(1_700_000_111_000),
      });
      prisma.payment.findUnique
        .mockResolvedValueOnce(
          buildPayment({ providerCreateTime: BigInt(Date.now()) }),
        )
        .mockResolvedValueOnce(performed)
        .mockResolvedValue(performed);

      const perform = await call('PerformTransaction', { id: 'pmt-xyz' });
      const check = await call('CheckTransaction', { id: 'pmt-xyz' });
      expect(check.result.perform_time).toBe(perform.result.perform_time);
      expect(check.result.state).toBe(perform.result.state);
    });

    it('reports the cancel reason for a cancelled transaction', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({
          providerState: -1,
          providerCancelTime: BigInt(1_700_000_222_000),
          cancelReason: 4,
        }),
      );
      const res = await call('CheckTransaction', { id: 'pmt-xyz' });
      expect(res.result.reason).toBe(4);
      expect(res.result.cancel_time).toBe(1_700_000_222_000);
    });

    it('rejects an unknown transaction with -31003', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      const res = await call('CheckTransaction', { id: 'nope' });
      expect(res.error.code).toBe(-31003);
    });
  });

  // ── GetStatement ───────────────────────────────────────────────────────────
  describe('GetStatement', () => {
    it('returns transactions in the requested window', async () => {
      prisma.payment.findMany.mockResolvedValue([
        buildPayment({
          providerState: 2,
          providerPerformTime: BigInt(1_700_000_111_000),
        }),
      ]);

      const res = await call('GetStatement', {
        from: 1_699_000_000_000,
        to: 1_701_000_000_000,
      });
      expect(res.result.transactions).toHaveLength(1);
      expect(res.result.transactions[0]).toEqual(
        expect.objectContaining({
          id: 'pmt-xyz',
          transaction: 'pay_1',
          amount: 21_500_000,
          account: { order_id: 'ord_1' },
          state: 2,
        }),
      );
    });

    it('returns an empty list for a window with no transactions', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      const res = await call('GetStatement', { from: 1, to: 2 });
      expect(res.result).toEqual({ transactions: [] });
    });

    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion -- the Prisma double and the JSON-RPC replies are untyped */
    it('asks for every transaction created in the window, oldest first, as Payme requires', async () => {
      prisma.payment.findMany.mockResolvedValue([]);

      await call('GetStatement', {
        from: 1_699_000_000_000,
        to: 1_701_000_000_000,
      });

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: {
          provider: 'PAYME',
          providerTransactionId: { not: null },
          providerCreateTime: {
            gte: BigInt(1_699_000_000_000),
            lte: BigInt(1_701_000_000_000),
          },
        },
        orderBy: [{ providerCreateTime: 'asc' }, { id: 'asc' }],
      });
    });

    it('reports them in the order they were created, cancelled ones included', async () => {
      prisma.payment.findMany.mockResolvedValue([
        buildPayment({
          id: 'pay_1',
          providerTransactionId: 'pmt-1',
          providerCreateTime: BigInt(1_700_000_000_000),
          providerState: -1,
        }),
        buildPayment({
          id: 'pay_2',
          providerTransactionId: 'pmt-2',
          providerCreateTime: BigInt(1_700_000_500_000),
          providerState: 2,
        }),
      ]);

      const res = await call('GetStatement', {
        from: 1,
        to: 2_000_000_000_000,
      });

      expect(
        res.result.transactions.map((t: any) => [t.id, t.create_time, t.state]),
      ).toEqual([
        ['pmt-1', 1_700_000_000_000, -1],
        ['pmt-2', 1_700_000_500_000, 2],
      ]);
    });
  });

  describe('a refund Payme asks for and cannot get (Phase 3)', () => {
    it('is raised for a person to take up, and Payme hears -31007', async () => {
      const alerts = { raise: jest.fn() };
      const withAlerts = new PaymeService(
        prisma,
        CONFIG as any,
        settlement as any,
        new PaymeFiscalReceiptService(prisma as any),
        alerts as any,
      );
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({ providerState: 2, status: 'PAID' }),
      );
      settlement.markCancelled.mockResolvedValue('not_refundable');

      const res: any = await withAlerts.handle(AUTH, {
        id: 1,
        method: 'CancelTransaction',
        params: { id: 'pmt-xyz', reason: 5 },
      });

      expect(res.error.code).toBe(-31007);
      expect(alerts.raise).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'refund_refused',
          severity: 'critical',
          context: expect.objectContaining({
            paymentId: 'pay_1',
            orderId: 'ord_1',
          }),
        }),
      );
      // A return under way: no seller is paid for the order until someone settles it and
      // releases the hold. Conditional, so a repeated request keeps the first hold.
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord_1', payoutHoldAt: null },
        data: {
          payoutHoldAt: expect.any(Date),
          payoutHoldReason: expect.stringContaining('refused'),
        },
      });
    });
  });
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion */
});

// ── Release fixes: params, active transaction, order state, concurrency ─────
describe('PaymeService — request validation, order state, active transaction', () => {
  let prisma: PrismaMock;
  let settlement: { markPaid: jest.Mock; markCancelled: jest.Mock };
  let svc: PaymeService;

  beforeEach(() => {
    prisma = createPrismaMock();
    settlement = {
      markPaid: jest.fn().mockResolvedValue('paid'),
      markCancelled: jest.fn().mockResolvedValue(undefined),
    };
    svc = new PaymeService(
      prisma,
      CONFIG,
      settlement as any,
      new PaymeFiscalReceiptService(prisma as any),
    );
    stubFiscalizableOrderLines(prisma);
    stubOpenPaymeInvoice(prisma);
  });

  const call = (method: string, params: unknown) =>
    svc.handle(AUTH, { id: 7, method, params } as any) as Promise<any>;

  describe('invalid params → -32600, before any lookup', () => {
    it.each([
      ['PerformTransaction', {}],
      ['CheckTransaction', { id: '' }],
      ['CancelTransaction', { id: 42 }],
      [
        'CreateTransaction',
        { time: 1, amount: 100, account: { order_id: 'o' } },
      ],
    ])('%s without a usable id', async (method, params) => {
      const res = await call(method, params);
      expect(res.error.code).toBe(-32600);
      expect(res.error.data).toBe('id');
      // Never coerced into a lookup for the string "undefined".
      expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    });

    it('a mistyped amount is a malformed request (a wrong NUMBER stays -31001)', async () => {
      const res = await call('CheckPerformTransaction', {
        amount: '21500000',
        account: { order_id: 'ord_1' },
      });
      expect(res.error.code).toBe(-32600);
      expect(res.error.data).toBe('amount');
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });

    it('a non-integer cancel reason', async () => {
      const res = await call('CancelTransaction', {
        id: 'pmt-xyz',
        reason: 'x',
      });
      expect(res.error.code).toBe(-32600);
    });

    it('GetStatement without from/to', async () => {
      expect((await call('GetStatement', { to: 1 })).error.data).toBe('from');
      expect((await call('GetStatement', { from: 1 })).error.data).toBe('to');
    });

    it('params that are not an object', async () => {
      const res = await call('CheckTransaction', ['pmt-xyz']);
      expect(res.error.code).toBe(-32600);
    });

    it('an unknown method is still -32601', async () => {
      expect((await call('Refund', {})).error.code).toBe(-32601);
    });
  });

  describe('CheckPerformTransaction — one active transaction per order', () => {
    const params = { amount: 21_500_000, account: { order_id: 'ord_1' } };

    beforeEach(() => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
    });

    it('refuses while another transaction is open (same code as CreateTransaction)', async () => {
      prisma.payment.findFirst.mockResolvedValue(buildPayment());
      const res = await call('CheckPerformTransaction', params);
      expect(res.error.code).toBe(-31050);
      expect(res.error.data).toBe('order_id');
    });

    it('allows when the open transaction is past the 12h window (Create would expire it)', async () => {
      prisma.payment.findFirst
        .mockResolvedValueOnce(
          buildPayment({
            providerCreateTime: BigInt(
              Date.now() - PAYME_TRANSACTION_TIMEOUT_MS - 1,
            ),
          }),
        )
        .mockResolvedValueOnce(openPaymeInvoice());
      const res = await call('CheckPerformTransaction', params);
      expect(res.result.allow).toBe(true);
    });

    it('refuses a CANCELLED order with -31008', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000, status: 'CANCELLED' }),
      );
      const res = await call('CheckPerformTransaction', params);
      expect(res.error.code).toBe(-31008);
    });
  });

  describe('CreateTransaction — order re-checked under the row lock', () => {
    it('refuses when the order was cancelled between the first read and the lock', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique
        .mockResolvedValueOnce(buildOrder({ id: 'ord_1', totalUzs: 215000 }))
        // The fiscal gate's read, still before the lock.
        .mockResolvedValueOnce(buildOrder({ id: 'ord_1', totalUzs: 215000 }))
        .mockResolvedValueOnce({ status: 'CANCELLED' });
      prisma.payment.findFirst.mockResolvedValue(null);

      const res = await call('CreateTransaction', {
        id: 'pmt-new',
        time: 1_700_000_000_000,
        amount: 21_500_000,
        account: { order_id: 'ord_1' },
      });
      expect(res.error.code).toBe(-31008);
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });
  });

  describe('PerformTransaction — honours the settlement outcome', () => {
    it('order no longer payable → -31008, never state 2', async () => {
      prisma.payment.findUnique.mockResolvedValue(buildPayment());
      settlement.markPaid.mockResolvedValue('order_not_payable');
      const res = await call('PerformTransaction', { id: 'pmt-xyz' });
      expect(res.error.code).toBe(-31008);
    });

    it('cancelled concurrently (not settleable, stored state -1) → -31008', async () => {
      prisma.payment.findUnique
        .mockResolvedValueOnce(buildPayment())
        .mockResolvedValueOnce(buildPayment({ providerState: -1 }));
      settlement.markPaid.mockResolvedValue('not_settleable');
      const res = await call('PerformTransaction', { id: 'pmt-xyz' });
      expect(res.error.code).toBe(-31008);
    });
  });
});

/**
 * PaymeService + the REAL SettlementService/OrderStatusService over an
 * in-memory store that serialises transactions and rolls back on error
 * (settlement-store.test-util.ts). Not PostgreSQL — it proves the logic.
 */
describe('PaymeService.PerformTransaction end-to-end (in-memory store)', () => {
  function build(orderStatus: OrderStatus) {
    const store = settlementStore({
      payments: [pendingPaymePayment()],
      orders: [order(orderStatus)],
    });
    const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
    const settlementSvc = new SettlementService(
      store.prisma as any,
      notifications as any,
      { emit: jest.fn() } as any,
      new OrderStatusService(store.prisma as any),
      CONFIG,
    );
    const payme = new PaymeService(
      store.prisma as any,
      CONFIG,
      settlementSvc,
      {} as any,
    );
    const perform = () =>
      payme.handle(AUTH, {
        id: 1,
        method: 'PerformTransaction',
        params: { id: 'pmt-xyz' },
      }) as Promise<any>;
    return { store, perform, notifications };
  }

  it('PENDING_PAYMENT order → Perform → state 2 and the order is PAID', async () => {
    const { store, perform } = build(OrderStatus.PENDING_PAYMENT);
    const res = await perform();
    expect(res.result.state).toBe(2);
    expect(store.order('ord_1').status).toBe(OrderStatus.PAID);
  });

  it('CANCELLED order → Perform → -31008; the order stays CANCELLED, nothing written', async () => {
    const { store, perform, notifications } = build(OrderStatus.CANCELLED);
    const res = await perform();
    expect(res.error.code).toBe(-31008);
    expect(store.order('ord_1').status).toBe(OrderStatus.CANCELLED);
    expect(store.payment('pay_1').providerState).toBe(1);
    expect(store.history()).toEqual([]);
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it.each([
    OrderStatus.PAID,
    OrderStatus.PROCESSING,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.REFUNDED,
    OrderStatus.EXPIRED,
  ])(
    '%s order → Perform → -31008; never settled a second time',
    async (status) => {
      const { store, perform, notifications } = build(status);
      const res = await perform();
      expect(res.error.code).toBe(-31008);
      expect(store.order('ord_1').status).toBe(status);
      expect(store.payment('pay_1').providerState).toBe(1);
      expect(store.history()).toEqual([]);
      expect(notifications.emit).not.toHaveBeenCalled();
    },
  );

  it('two concurrent Performs: both answer state 2 with the SAME perform_time, one settlement', async () => {
    const { store, perform, notifications } = build(
      OrderStatus.PENDING_PAYMENT,
    );
    const [a, b] = await Promise.all([perform(), perform()]);
    expect(a.result.state).toBe(2);
    expect(b.result.state).toBe(2);
    expect(a.result.perform_time).toBe(b.result.perform_time);
    expect(
      store.history().filter((h) => h.status === OrderStatus.PAID),
    ).toHaveLength(1);
    expect(notifications.emit).toHaveBeenCalledTimes(1);
  });

  it('a repeated Perform after success is idempotent', async () => {
    const { store, perform } = build(OrderStatus.PENDING_PAYMENT);
    const first = await perform();
    const second = await perform();
    expect(second.result).toEqual(first.result);
    expect(
      store.history().filter((h) => h.status === OrderStatus.PAID),
    ).toHaveLength(1);
  });
});

/**
 * Perform and Cancel on one transaction: PaymeService with the REAL settlement over
 * the in-memory store. It serialises transactions and re-checks a conditional write
 * against the current row, which is what these tests rely on. It is not PostgreSQL,
 * so they prove the logic of the conditional writes, not behaviour under real load.
 */
describe('PaymeService — Perform and Cancel on one transaction (in-memory store)', () => {
  function build(paymentOver = {}, orderStatus = OrderStatus.PENDING_PAYMENT) {
    const store = settlementStore({
      payments: [
        pendingPaymePayment({
          amountTiyin: BigInt(21_500_000),
          providerCancelTime: null,
          cancelReason: null,
          ...paymentOver,
        }),
      ],
      orders: [order(orderStatus)],
    });
    const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
    const settlementSvc = new SettlementService(
      store.prisma as any,
      notifications as any,
      { emit: jest.fn() } as any,
      new OrderStatusService(store.prisma as any),
      CONFIG,
    );
    const payme = new PaymeService(
      store.prisma as any,
      CONFIG,
      settlementSvc,
      {} as any,
    );
    const rpc = (method: string, params: Record<string, unknown>) =>
      payme.handle(AUTH, { id: 1, method, params }) as Promise<any>;
    return {
      store,
      notifications,
      perform: () => rpc('PerformTransaction', { id: 'pmt-xyz' }),
      cancel: (reason = 3) =>
        rpc('CancelTransaction', { id: 'pmt-xyz', reason }),
    };
  }

  /**
   * Run `between` right after the next payment read, before the reader sees the
   * result: the reader goes on holding a row that is already out of date, which is
   * the window a read-then-write would race in.
   */
  function staleNextRead(
    store: ReturnType<typeof settlementStore>,
    between: () => Promise<unknown>,
  ) {
    const db = store.prisma as any;
    const read = db.payment.findUnique;
    let fired = false;
    db.payment.findUnique = async (args: unknown) => {
      const row = await read(args);
      if (!fired) {
        fired = true;
        await between();
      }
      return row;
    };
  }

  const refundRows = (store: ReturnType<typeof settlementStore>) =>
    store.history().filter((h) => h.status === OrderStatus.REFUNDED);

  describe('A — Perform wins', () => {
    const expectRefunded = (
      store: ReturnType<typeof settlementStore>,
      res: any,
    ) => {
      expect(res.result.state).toBe(-2);
      expect(store.payment('pay_1')).toMatchObject({
        status: 'REFUNDED',
        providerState: -2,
        cancelReason: 3,
      });
      expect(store.order('ord_1').status).toBe(OrderStatus.REFUNDED);
      expect(store.refunds()).toHaveLength(1);
      expect(Number(store.refunds()[0].amountUzs)).toBe(215000);
      expect(refundRows(store)).toHaveLength(1);
    };

    it('a Cancel arriving after the Perform refunds: state -2, never -1', async () => {
      const { store, perform, cancel } = build();
      expect((await perform()).result.state).toBe(2);
      expectRefunded(store, await cancel());
    });

    it('a Cancel that read state 1 just before the Perform committed refunds too', async () => {
      // The audit's sequence. The old claim turned this row CANCELLED / -1 and left
      // the order PAID: goods shipped with the money handed back.
      const { store, perform, cancel } = build();
      staleNextRead(store, perform);

      const res = await cancel();

      expect(store.payment('pay_1').status).not.toBe('CANCELLED');
      expectRefunded(store, res);
    });

    it('once the goods are handed over the same Cancel gets -31007 and nothing moves', async () => {
      const { store, perform, cancel } = build();
      await perform();
      await (store.prisma as any).order.updateMany({
        where: { id: 'ord_1' },
        data: { status: OrderStatus.SHIPPED },
      });

      const res = await cancel();

      expect(res.error.code).toBe(-31007);
      expect(store.payment('pay_1')).toMatchObject({
        status: 'PAID',
        providerState: 2,
      });
      expect(store.order('ord_1').status).toBe(OrderStatus.SHIPPED);
      expect(store.refunds()).toEqual([]);
    });

    it('an order shipped between the read and the write stops the refund the same way', async () => {
      const { store, perform, cancel } = build();
      await perform();
      staleNextRead(store, () =>
        (store.prisma as any).order.updateMany({
          where: { id: 'ord_1' },
          data: { status: OrderStatus.SHIPPED },
        }),
      );

      const res = await cancel();

      expect(res.error.code).toBe(-31007);
      expect(store.payment('pay_1').status).toBe('PAID');
      expect(store.order('ord_1').status).toBe(OrderStatus.SHIPPED);
      expect(store.refunds()).toEqual([]);
    });
  });

  describe('B — Cancel wins', () => {
    const expectCancelled = (store: ReturnType<typeof settlementStore>) => {
      expect(store.payment('pay_1')).toMatchObject({
        status: 'CANCELLED',
        providerState: -1,
      });
      expect(store.order('ord_1').status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(
        store.history().filter((h) => h.status === OrderStatus.PAID),
      ).toEqual([]);
      expect(store.refunds()).toEqual([]);
    };

    it('a Perform after the Cancel is refused and settles nothing', async () => {
      const { store, perform, cancel, notifications } = build();
      expect((await cancel()).result.state).toBe(-1);

      const res = await perform();

      expect(res.error.code).toBe(-31008);
      expectCancelled(store);
      expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('a Perform that read state 1 just before the Cancel committed is refused too', async () => {
      const { store, perform, cancel, notifications } = build();
      staleNextRead(store, cancel);

      const res = await perform();

      expect(res.error.code).toBe(-31008);
      expectCancelled(store);
      expect(notifications.emit).not.toHaveBeenCalled();
    });
  });

  describe('C — repeats', () => {
    it('a repeated Perform pays once', async () => {
      const { store, perform, notifications } = build();
      const first = await perform();
      const second = await perform();
      expect(second.result).toEqual(first.result);
      expect(
        store.history().filter((h) => h.status === OrderStatus.PAID),
      ).toHaveLength(1);
      expect(notifications.emit).toHaveBeenCalledTimes(1);
    });

    it('a repeated Cancel before payment replays the stored outcome', async () => {
      const { store, cancel } = build();
      const first = await cancel();
      const second = await cancel();
      expect(second.result).toEqual(first.result);
      expect(store.refunds()).toEqual([]);
    });

    it('a repeated Cancel after payment refunds once', async () => {
      const { store, perform, cancel } = build();
      await perform();
      const first = await cancel();
      const second = await cancel();
      expect(second.result).toEqual(first.result);
      expect(store.refunds()).toHaveLength(1);
      expect(refundRows(store)).toHaveLength(1);
    });

    it('a Perform after a refund is refused', async () => {
      const { store, perform, cancel } = build();
      await perform();
      await cancel();
      expect((await perform()).error.code).toBe(-31008);
      expect(store.payment('pay_1').status).toBe('REFUNDED');
    });
  });

  describe('D — at the same time', () => {
    it('two Performs: one settlement, the same perform_time for both', async () => {
      const { store, perform } = build();
      const [a, b] = await Promise.all([perform(), perform()]);
      expect(a.result).toEqual(b.result);
      expect(a.result.state).toBe(2);
      expect(
        store.history().filter((h) => h.status === OrderStatus.PAID),
      ).toHaveLength(1);
    });

    it('two Cancels before payment: the same outcome for both', async () => {
      const { store, cancel } = build();
      const [a, b] = await Promise.all([cancel(), cancel()]);
      expect(a.result).toEqual(b.result);
      expect(a.result.state).toBe(-1);
      expect(store.payment('pay_1').status).toBe('CANCELLED');
    });

    it('two Cancels after payment: one refund, the same outcome for both', async () => {
      const { store, perform, cancel } = build();
      await perform();
      const [a, b] = await Promise.all([cancel(), cancel()]);
      expect(a.result).toEqual(b.result);
      expect(a.result.state).toBe(-2);
      expect(store.refunds()).toHaveLength(1);
      expect(refundRows(store)).toHaveLength(1);
    });

    it.each([
      ['Perform first', true],
      ['Cancel first', false],
    ])(
      'Perform and Cancel together (%s): payment and order end up agreeing',
      async (_, performFirst) => {
        const { store, perform, cancel } = build();
        const runs = performFirst
          ? [perform(), cancel()]
          : [cancel(), perform()];
        await Promise.all(runs);

        const payment = store.payment('pay_1');
        const orderStatus = store.order('ord_1').status;
        // Only two ends are consistent. CANCELLED with a PAID order is the one the
        // old claim produced.
        if (payment.status === 'CANCELLED') {
          expect(payment.providerState).toBe(-1);
          expect(orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
          expect(store.refunds()).toEqual([]);
        } else {
          expect(payment.status).toBe('REFUNDED');
          expect(payment.providerState).toBe(-2);
          expect(orderStatus).toBe(OrderStatus.REFUNDED);
          expect(store.refunds()).toHaveLength(1);
        }
      },
    );
  });

  it('a timed-out Perform that finds the payment settled reports that, not a timeout', async () => {
    const { store, perform } = build({
      providerCreateTime: BigInt(Date.now() - PAYME_TRANSACTION_TIMEOUT_MS - 1),
    });
    const db = store.prisma as any;
    // Another Perform, read before the window closed, settles first.
    staleNextRead(store, () =>
      db.$transaction(async (tx: any) => {
        await tx.payment.updateMany({
          where: { id: 'pay_1' },
          data: {
            status: 'PAID',
            providerState: 2,
            providerPerformTime: BigInt(1_700_000_111_000),
          },
        });
        await tx.order.updateMany({
          where: { id: 'ord_1' },
          data: { status: OrderStatus.PAID },
        });
      }),
    );

    const res = await perform();

    expect(res.result).toMatchObject({
      state: 2,
      perform_time: 1_700_000_111_000,
    });
    expect(store.payment('pay_1').status).toBe('PAID');
  });
});
