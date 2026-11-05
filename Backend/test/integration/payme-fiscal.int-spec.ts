/* eslint-disable @typescript-eslint/no-explicit-any */
// The Payme fiscal data against a real PostgreSQL: what a mock cannot show. The trigger
// that keeps a frozen receipt from changing, the foreign keys that hold it, the query
// that decides which invoice is open, the JSON round trip, and the unique key and row
// lock under concurrent calls.
//
// Run with TEST_DATABASE_URL set; see admin-categories.int-spec.ts. NOT YET RUN: no
// PostgreSQL was available when it was written, so a failure may be the test's own.

import { OrderStatus, PaymentProvider, PaymentStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PaymentsService } from '../../src/orders/payments.service';
import { PaymeFiscalReceiptService } from '../../src/orders/webhooks/payme-fiscal-receipt.service';
import { findOpenPaymeInvoice } from '../../src/orders/webhooks/payme-invoice.util';
import { PaymeService } from '../../src/orders/webhooks/payme.service';
import { fakeConfig } from '../utils/harness';
import { describeWithDb, integrationPrisma } from '../utils/integration-db';

const run = randomBytes(3).toString('hex');
const scoped = (name: string) => `it-${run}-${name}`;

const KEY = 'integration-merchant-key';
const AUTH = 'Basic ' + Buffer.from(`Paycom:${KEY}`).toString('base64');
const TIYIN = 10_000_000;
const DETAIL = {
  receipt_type: 0,
  items: [
    {
      title: 'Рулевая рейка «Ё» 🚗',
      price: TIYIN,
      count: 1,
      code: '08708001133000000',
      package_code: '1533557',
      vat_percent: 12.5,
      commission_info: { tin: '301234567' },
    },
  ],
};
const FISCAL_DATA = {
  receipt_id: 121,
  status_code: 0,
  message: 'accepted',
  terminal_id: 'EP000000000025',
  fiscal_sign: '800031554082',
  qr_code_url: 'https://ofd.soliq.uz/check?t=1',
  date: '20220706221021',
};

describeWithDb('Payme fiscal data (real PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const config = fakeConfig({
    PAYME_MERCHANT_KEY: KEY,
    PAYME_MERCHANT_ID: 'merchant-1',
    PAYME_ACCOUNT_FIELD: 'order_id',
  });
  const payments = new PaymentsService(
    prisma as never,
    config as never,
    { buildOrderDetail: jest.fn().mockResolvedValue(DETAIL) } as never,
  );
  const payme = new PaymeService(
    prisma as never,
    config as never,
    {} as never,
    new PaymeFiscalReceiptService(prisma as never),
  );
  const rpc = (method: string, params: unknown) =>
    payme.handle(AUTH, { id: 1, method, params } as never) as Promise<any>;

  let userId: string;
  const created: string[] = [];

  const order = async (name: string) => {
    const id = scoped(name);
    created.push(id);
    await prisma.order.create({
      data: {
        id,
        userId,
        status: OrderStatus.PENDING_PAYMENT,
        subtotalUzs: TIYIN / 100,
        totalUzs: TIYIN / 100,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return id;
  };
  const invoice = (orderId: string, name: string, over: object = {}) =>
    prisma.payment.create({
      data: {
        id: scoped(name),
        orderId,
        provider: PaymentProvider.PAYME,
        status: PaymentStatus.PENDING,
        amountUzs: TIYIN / 100,
        amountTiyin: BigInt(TIYIN),
        expiresAt: new Date(Date.now() + 60_000),
        fiscalSnapshot: {
          create: { detail: DETAIL, totalTiyin: BigInt(TIYIN) },
        },
        ...over,
      },
    });

  beforeAll(async () => {
    const user = await prisma.appUser.create({
      data: { phoneE164: `+99891${Date.now().toString().slice(-7)}` },
    });
    userId = user.id;
  });

  afterEach(async () => {
    const where = { payment: { orderId: { in: created } } };
    await prisma.paymeFiscalReceipt.deleteMany({ where });
    await prisma.paymeFiscalSnapshot.deleteMany({ where });
    await prisma.order.deleteMany({ where: { id: { in: created } } });
    created.length = 0;
  });

  afterAll(async () => {
    await prisma.appUser.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  describe('a frozen receipt', () => {
    it('cannot be updated, through Prisma or by hand', async () => {
      const row = await invoice(await order('frozen'), 'pay-frozen');

      await expect(
        prisma.paymeFiscalSnapshot.update({
          where: { paymentId: row.id },
          data: { detail: { receipt_type: 0, items: [] } },
        }),
      ).rejects.toThrow(/immutable/);
      await expect(
        prisma.$executeRaw`UPDATE payme_fiscal_snapshots SET total_tiyin = 1 WHERE payment_id = ${row.id}`,
      ).rejects.toThrow(/immutable/);

      const after = await prisma.paymeFiscalSnapshot.findUniqueOrThrow({
        where: { paymentId: row.id },
      });
      expect(after.detail).toEqual(DETAIL);
      expect(after.totalTiyin).toBe(BigInt(TIYIN));
    });

    it('holds its payment: neither can be deleted out from under it', async () => {
      const orderId = await order('held');
      const row = await invoice(orderId, 'pay-held');

      await expect(
        prisma.payment.delete({ where: { id: row.id } }),
      ).rejects.toThrow();
      await expect(
        prisma.order.delete({ where: { id: orderId } }),
      ).rejects.toThrow();
    });

    it('comes back from Check exactly as it was written, with no id to find it by', async () => {
      const orderId = await order('check');
      await invoice(orderId, 'pay-check');

      const res = await rpc('CheckPerformTransaction', {
        amount: TIYIN,
        account: { order_id: orderId },
      });

      expect(res.result).toEqual({ allow: true, detail: DETAIL });
    });
  });

  describe('which invoice is open', () => {
    it('only one no transaction took, in its window, with a receipt', async () => {
      const orderId = await order('open');
      const past = new Date(Date.now() - 60_000);
      await invoice(orderId, 'pay-expired', { expiresAt: past });
      await invoice(orderId, 'pay-bound', { providerTransactionId: scoped('t') });
      await invoice(orderId, 'pay-cancelled', {
        status: PaymentStatus.CANCELLED,
      });
      await prisma.payment.create({
        data: {
          id: scoped('pay-no-receipt'),
          orderId,
          provider: PaymentProvider.PAYME,
          status: PaymentStatus.PENDING,
          amountUzs: 1,
        },
      });
      expect(await findOpenPaymeInvoice(prisma, orderId)).toBeNull();

      const open = await invoice(orderId, 'pay-open', { expiresAt: null });
      const found = await findOpenPaymeInvoice(prisma, orderId);
      expect(found?.id).toBe(open.id);
      expect(found?.fiscalSnapshot?.detail).toEqual(DETAIL);
    });
  });

  describe('starting a payment', () => {
    it('concurrent taps on Pay leave one invoice with one receipt', async () => {
      const orderId = await order('taps');

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          payments.createPaymeInvoice(userId, { order_id: orderId } as never),
        ),
      );

      expect(new Set(results.map((r) => r.payment_id)).size).toBe(1);
      expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    });

    it('Create takes that invoice, and the next payment freezes its own receipt', async () => {
      const orderId = await order('bind');
      const first = await payments.createPaymeInvoice(userId, {
        order_id: orderId,
      } as never);

      const res = await rpc('CreateTransaction', {
        id: scoped('pmt'),
        time: Date.now(),
        amount: TIYIN,
        account: { order_id: orderId },
      });
      expect(res.result.transaction).toBe(first.payment_id);

      const second = await payments.createPaymeInvoice(userId, {
        order_id: orderId,
      } as never);
      expect(second.payment_id).not.toBe(first.payment_id);
      expect(await prisma.paymeFiscalSnapshot.count({
        where: { payment: { orderId } },
      })).toBe(2);
    });
  });

  describe('SetFiscalData', () => {
    const paidTransaction = async (name: string) => {
      const orderId = await order(name);
      const transactionId = scoped(`pmt-${name}`);
      const row = await invoice(orderId, `pay-${name}`, {
        providerTransactionId: transactionId,
        providerState: 2,
        status: PaymentStatus.PAID,
      });
      return { paymentId: row.id, transactionId };
    };
    const send = (id: string, type = 'PERFORM', data: object = FISCAL_DATA) =>
      rpc('SetFiscalData', { id, type, fiscal_data: data });

    it('concurrent copies of one callback leave one row, and all succeed', async () => {
      const { paymentId, transactionId } = await paidTransaction('copies');

      const replies = await Promise.all(
        Array.from({ length: 5 }, () => send(transactionId)),
      );

      expect(replies.map((r) => r.result)).toEqual(
        Array(5).fill({ success: true }),
      );
      expect(
        await prisma.paymeFiscalReceipt.count({ where: { paymentId } }),
      ).toBe(1);
    });

    it('stores a sale and its cancellation as two rows', async () => {
      const { paymentId, transactionId } = await paidTransaction('both');

      await send(transactionId);
      await send(transactionId, 'CANCEL', { ...FISCAL_DATA, receipt_id: 123 });

      const rows = await prisma.paymeFiscalReceipt.findMany({
        where: { paymentId },
        orderBy: { type: 'asc' },
      });
      expect(rows.map((r) => [r.type, r.receiptId])).toEqual([
        ['PERFORM', '121'],
        ['CANCEL', '123'],
      ]);
    });

    it('never overwrites an accepted receipt, and keeps what differed beside it', async () => {
      const { paymentId, transactionId } = await paidTransaction('conflict');
      await send(transactionId);

      const later = { ...FISCAL_DATA, fiscal_sign: 'other' };
      const res = await send(transactionId, 'PERFORM', later);

      expect(res.result).toEqual({ success: true });
      const row = await prisma.paymeFiscalReceipt.findUniqueOrThrow({
        where: { paymentId_type: { paymentId, type: 'PERFORM' } },
      });
      expect(row.fiscalSign).toBe(FISCAL_DATA.fiscal_sign);
      expect(row.conflictCount).toBe(1);
      expect(row.lastConflictData).toEqual(later);
    });

    it('lets an acceptance replace a failure, through the conditional write', async () => {
      const { paymentId, transactionId } = await paidTransaction('retry');
      await send(transactionId, 'PERFORM', {
        receipt_id: 121,
        status_code: 9,
        message: 'OFD is down',
      });

      await send(transactionId);

      const row = await prisma.paymeFiscalReceipt.findUniqueOrThrow({
        where: { paymentId_type: { paymentId, type: 'PERFORM' } },
      });
      expect(row.statusCode).toBe(0);
      expect(row.fiscalSign).toBe(FISCAL_DATA.fiscal_sign);
    });
  });
});
