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
import { Prisma } from '@prisma/client';
import {
  PaymeService,
  PAYME_TRANSACTION_TIMEOUT_MS,
  PAYME_TIMEOUT_REASON,
} from './payme.service';
import {
  createPrismaMock,
  fakeConfig,
  fakeFiscal,
  buildOrder,
  PrismaMock,
} from '../../../test/utils/harness';

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
      fakeFiscal(prisma),
    );
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
        fakeFiscal(prisma),
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
      expect(res.result).toEqual({ allow: true });
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
      expect(res.result).toEqual({ allow: true });
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
    it('returns the fiscal receipt alongside allow', async () => {
      // buildOrder(): 185 000 goods + 25 000 delivery + 5 000 fee = 215 000,
      // which is the amount Payme is about to charge — so the receipt has to
      // carry a line for each of the three.
      const fiscal = new PaymeService(
        prisma,
        CONFIG as any,
        settlement as any,
        fakeFiscal(prisma, {
          SERVICE_FEE_MXIK: '10307001001000000',
          SERVICE_FEE_PACKAGE_CODE: '1000001',
        }),
      );
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      prisma.orderItem.findMany.mockResolvedValue([
        {
          id: 'oi_1',
          partId: 'part_1',
          title: 'Тормозные колодки',
          quantity: 1,
          priceUzs: 185000,
        },
      ]);
      prisma.catalogPart.findMany.mockResolvedValue([
        {
          id: 'part_1',
          packageForm: 'SET',
          kind: 'SPARE_PART',
          oilType: null,
          category: {
            mxik: '08708005011000000',
            packageCodeSingle: '1417722',
            packageCodeSet: '1417723',
          },
          seller: { tin: '301234567', vatPercent: 0 },
        },
      ]);

      const res: any = await fiscal.handle(AUTH, {
        id: 1,
        method: 'CheckPerformTransaction',
        params: { account: { order_id: 'ord_1' }, amount: 21_500_000 },
      });

      expect(res.result).toEqual({
        allow: true,
        detail: {
          receipt_type: 0,
          items: [
            {
              title: 'Тормозные колодки',
              price: 18_500_000,
              count: 1,
              code: '08708005011000000',
              package_code: '1417723',
              vat_percent: 0,
              commission_info: { tin: '301234567' },
            },
            {
              title: 'Услуга доставки',
              price: 2_500_000,
              count: 1,
              code: '05320001001000000',
              package_code: '1000000',
              vat_percent: 0,
            },
            {
              title: 'Сервисный сбор',
              price: 500_000,
              count: 1,
              code: '10307001001000000',
              package_code: '1000001',
              vat_percent: 0,
            },
          ],
        },
      });

      // The receipt adds up to exactly the amount being authorised.
      const sum = res.result.detail.items.reduce(
        (t: number, i: any) => t + i.price * i.count,
        0,
      );
      expect(sum).toBe(21_500_000);
    });

    it('refuses an order it cannot fiscalize instead of sending a partial receipt', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      prisma.orderItem.findMany.mockResolvedValue([
        {
          id: 'oi_1',
          partId: 'part_1',
          title: 'Колодки',
          quantity: 1,
          priceUzs: 150000,
        },
      ]);
      // The dealer's ИНН / ставка НДС have not been entered by an operator yet.
      prisma.catalogPart.findMany.mockResolvedValue([
        {
          id: 'part_1',
          packageForm: null,
          category: {
            mxik: '08708005011000000',
            packageCodeSingle: '1417722',
            packageCodeSet: null,
          },
          seller: { tin: null, vatPercent: null },
        },
      ]);

      const res = await call('CheckPerformTransaction', {
        account: { order_id: 'ord_1' },
        amount: 21_500_000,
      });

      expect(res.error.code).toBe(-31008);
      expect(res.result).toBeUndefined();
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

    it('creates a transaction in state 1', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      prisma.payment.findFirst.mockResolvedValue(null);
      // The persisted row carries the create time Payme sent, which is what the
      // reply echoes back.
      prisma.payment.create.mockResolvedValue(
        buildPayment({ providerCreateTime: BigInt(params.time) }),
      );

      const res = await call('CreateTransaction', params);
      expect(res.result).toEqual({
        create_time: 1_700_000_000_000,
        transaction: 'pay_1',
        state: 1,
      });
      // Payme's clock is authoritative for create_time — we persist what it sent.
      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerCreateTime: BigInt(params.time),
          }),
        }),
      );
    });

    it('binds an existing unbound invoice row instead of creating a second payment', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      // No active transaction, but an invoice row awaiting binding.
      prisma.payment.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          buildPayment({ id: 'pay_invoice', providerTransactionId: null }),
        );
      prisma.payment.update.mockResolvedValue(
        buildPayment({ id: 'pay_invoice' }),
      );

      const res = await call('CreateTransaction', params);
      expect(res.result.transaction).toBe('pay_invoice');
      expect(prisma.payment.create).not.toHaveBeenCalled();
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
      // Nothing on the first read; the unique index rejects our insert because a
      // parallel request won, and the re-read then finds the winner.
      const winner = buildPayment({ id: 'pay_winner' });
      prisma.payment.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', totalUzs: 215000 }),
      );
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockRejectedValue(uniqueViolation());

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
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue(buildPayment());

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
        .mockResolvedValueOnce(null);
      prisma.payment.create.mockResolvedValue(buildPayment());

      const res = await call('CreateTransaction', params);
      expect(res.result.state).toBe(1);
      // The stale row is cancelled with the timeout reason.
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pay_stale' },
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

    it('refuses to refund a delivered order with -31007', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({ providerState: 2 }),
      );
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', status: 'DELIVERED' }),
      );

      const res = await call('CancelTransaction', { id: 'pmt-xyz', reason: 5 });
      expect(res.error.code).toBe(-31007);
      expect(settlement.markCancelled).not.toHaveBeenCalled();
    });

    it('refuses to refund a shipped order with -31007', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        buildPayment({ providerState: 2 }),
      );
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', status: 'SHIPPED' }),
      );

      const res = await call('CancelTransaction', { id: 'pmt-xyz', reason: 5 });
      expect(res.error.code).toBe(-31007);
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
  });
});
