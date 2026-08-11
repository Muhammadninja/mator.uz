import { createHash } from 'crypto';
import { PaymentsService } from '../../src/orders/payments.service';
import { PaymeService } from '../../src/orders/webhooks/payme.service';
import { ClickService } from '../../src/orders/webhooks/click.service';
import {
  createPrismaMock,
  fakeConfig,
  fakeFiscal,
  buildOrder,
  PrismaMock,
} from '../utils/harness';

describe('Payments + webhooks smoke', () => {
  let prisma: PrismaMock;
  let settlement: { markPaid: jest.Mock; markCancelled: jest.Mock };
  beforeEach(() => {
    prisma = createPrismaMock();
    settlement = {
      markPaid: jest.fn().mockResolvedValue(undefined),
      markCancelled: jest.fn().mockResolvedValue(undefined),
    };
  });

  describe('Invoices', () => {
    it('builds a Payme invoice with the official checkout link + tiyin amount', async () => {
      const svc = new PaymentsService(
        prisma,
        fakeConfig({
          PAYME_MERCHANT_ID: 'merchant-1',
          PAYME_ACCOUNT_FIELD: 'order_id',
        }),
        fakeFiscal(prisma),
      );
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({
          id: 'ord_1',
          userId: 'usr_1',
          status: 'PENDING_PAYMENT',
          totalUzs: 215000,
        }),
      );
      prisma.payment.create.mockResolvedValue({ id: 'pay_1' });

      const res = await svc.createPaymeInvoice('usr_1', {
        order_id: 'ord_1',
      } as any);
      expect(res.payment_id).toBe('pay_1');
      expect(res.amount_tiyin).toBe(21_500_000);

      // Official format: <checkout host>/base64(m=…;ac.order_id=…;a=<tiyin>).
      expect(res.deep_link.startsWith('https://checkout.paycom.uz/')).toBe(
        true,
      );
      const decoded = Buffer.from(
        res.deep_link.split('/').pop() as string,
        'base64',
      ).toString('utf8');
      expect(decoded).toBe('m=merchant-1;ac.order_id=ord_1;a=21500000');
    });

    it('refuses to invoice an order whose dealer tax data is missing', async () => {
      const svc = new PaymentsService(prisma, fakeConfig(), fakeFiscal(prisma));
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', userId: 'usr_1', status: 'PENDING_PAYMENT' }),
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
      prisma.catalogPart.findMany.mockResolvedValue([
        {
          id: 'part_1',
          packageForm: null,
          kind: 'SPARE_PART',
          oilType: null,
          category: {
            mxik: '08708005011000000',
            packageCodeSingle: '1417722',
            packageCodeSet: null,
          },
          // The operator has not entered this dealer's ИНН / ставка НДС yet.
          seller: { tin: null, vatPercent: null },
        },
      ]);

      await expect(
        svc.createPaymeInvoice('usr_1', { order_id: 'ord_1' } as any),
      ).rejects.toThrow(/temporarily unavailable for online payment/);
      // No checkout link is minted for an order that must not reach Payme.
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('invoices normally once the dealer tax data is filled in', async () => {
      // The receipt has to reconcile with what is charged, so the line prices
      // match buildOrder(): 185 000 goods + 25 000 delivery + 5 000 fee.
      const svc = new PaymentsService(
        prisma,
        fakeConfig(),
        fakeFiscal(prisma, {
          SERVICE_FEE_MXIK: '10307001001000000',
          SERVICE_FEE_PACKAGE_CODE: '1000001',
        }),
      );
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', userId: 'usr_1', status: 'PENDING_PAYMENT' }),
      );
      prisma.orderItem.findMany.mockResolvedValue([
        {
          id: 'oi_1',
          partId: 'part_1',
          title: 'Колодки',
          quantity: 1,
          priceUzs: 185000,
        },
      ]);
      // Same product row — only the DEALER changed, which is the whole point of
      // holding tax data on the dealer rather than on every product.
      prisma.catalogPart.findMany.mockResolvedValue([
        {
          id: 'part_1',
          packageForm: null,
          kind: 'SPARE_PART',
          oilType: null,
          category: {
            mxik: '08708005011000000',
            packageCodeSingle: '1417722',
            packageCodeSet: null,
          },
          seller: { tin: '301234567', vatPercent: 0 },
        },
      ]);
      prisma.payment.create.mockResolvedValue({ id: 'pay_1' });

      await expect(
        svc.createPaymeInvoice('usr_1', { order_id: 'ord_1' } as any),
      ).resolves.toMatchObject({ payment_id: 'pay_1' });
    });

    it('refuses to invoice an order that is not awaiting payment', async () => {
      const svc = new PaymentsService(prisma, fakeConfig(), fakeFiscal(prisma));
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ userId: 'usr_1', status: 'PAID' }),
      );
      await expect(
        svc.createPaymeInvoice('usr_1', { order_id: 'ord_1' } as any),
      ).rejects.toThrow(/awaiting payment/);
    });
  });

  describe('Payme JSON-RPC', () => {
    const KEY = 'merchant-secret';
    const auth = 'Basic ' + Buffer.from(`Paycom:${KEY}`).toString('base64');
    const config = fakeConfig({
      PAYME_MERCHANT_KEY: KEY,
      PAYME_ACCOUNT_FIELD: 'order_id',
    });

    it('rejects a request with a bad merchant key (-32504)', async () => {
      const svc = new PaymeService(
        prisma,
        config,
        settlement as any,
        fakeFiscal(prisma),
      );
      const res: any = await svc.handle('Basic wrong', {
        id: 1,
        method: 'CheckPerformTransaction',
        params: {},
      });
      expect(res.error.code).toBe(-32504);
    });

    it('CheckPerformTransaction allows a valid pending order', async () => {
      const svc = new PaymeService(
        prisma,
        config,
        settlement as any,
        fakeFiscal(prisma),
      );
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({
          id: 'ord_1',
          status: 'PENDING_PAYMENT',
          totalUzs: 215000,
        }),
      );
      const res: any = await svc.handle(auth, {
        id: 1,
        method: 'CheckPerformTransaction',
        params: { account: { order_id: 'ord_1' }, amount: 21_500_000 },
      });
      expect(res.result).toEqual({ allow: true });
    });

    it('rejects an incorrect amount (-31001)', async () => {
      const svc = new PaymeService(
        prisma,
        config,
        settlement as any,
        fakeFiscal(prisma),
      );
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({
          id: 'ord_1',
          status: 'PENDING_PAYMENT',
          totalUzs: 215000,
        }),
      );
      const res: any = await svc.handle(auth, {
        id: 1,
        method: 'CheckPerformTransaction',
        params: { account: { order_id: 'ord_1' }, amount: 999 },
      });
      expect(res.error.code).toBe(-31001);
    });

    it('CreateTransaction then PerformTransaction settles the payment (state 1 → 2)', async () => {
      const svc = new PaymeService(
        prisma,
        config,
        settlement as any,
        fakeFiscal(prisma),
      );
      // CreateTransaction: no existing transaction (findUnique, keyed on the
      // (provider, providerTransactionId) unique index), no active/bindable
      // payment -> create fresh.
      prisma.payment.findUnique.mockResolvedValue(null);
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({
          id: 'ord_1',
          status: 'PENDING_PAYMENT',
          totalUzs: 215000,
        }),
      );
      prisma.payment.create.mockResolvedValue({ id: 'pay_1' });

      const created: any = await svc.handle(auth, {
        id: 1,
        method: 'CreateTransaction',
        params: {
          id: 'pmt-xyz',
          time: 1700000000000,
          amount: 21_500_000,
          account: { order_id: 'ord_1' },
        },
      });
      expect(created.result).toEqual(
        expect.objectContaining({ transaction: 'pay_1', state: 1 }),
      );

      // PerformTransaction: the transaction is found in state 1 and settled; the
      // reply then re-reads the row so it carries the STORED perform_time.
      const createdNow = BigInt(Date.now());
      prisma.payment.findUnique
        .mockResolvedValueOnce({
          id: 'pay_1',
          providerState: 1,
          providerCreateTime: createdNow,
        })
        .mockResolvedValueOnce({
          id: 'pay_1',
          providerState: 2,
          providerCreateTime: createdNow,
          providerPerformTime: BigInt(1_700_000_111_000),
        });
      const performed: any = await svc.handle(auth, {
        id: 2,
        method: 'PerformTransaction',
        params: { id: 'pmt-xyz' },
      });
      expect(performed.result).toEqual(
        expect.objectContaining({
          transaction: 'pay_1',
          state: 2,
          perform_time: 1_700_000_111_000,
        }),
      );
      expect(settlement.markPaid).toHaveBeenCalledWith(
        'pay_1',
        expect.any(Number),
      );
    });
  });

  describe('Click', () => {
    const SECRET = 'click-secret';
    const config = fakeConfig({ CLICK_SECRET_KEY: SECRET });

    function sign(p: Record<string, any>, isComplete: boolean) {
      const parts = [
        p.click_trans_id,
        p.service_id,
        SECRET,
        p.merchant_trans_id,
      ];
      if (isComplete) parts.push(p.merchant_prepare_id);
      parts.push(p.amount, p.action, p.sign_time);
      return createHash('md5').update(parts.join('')).digest('hex');
    }

    it('prepare accepts a correctly-signed request', async () => {
      const svc = new ClickService(prisma, config, settlement as any);
      const p: Record<string, any> = {
        click_trans_id: '777',
        service_id: '12345',
        merchant_trans_id: 'ord_1',
        amount: 215000,
        action: 0,
        sign_time: '2026-06-14 10:00:00',
      };
      p.sign_string = sign(p, false);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({
          id: 'ord_1',
          status: 'PENDING_PAYMENT',
          totalUzs: 215000,
        }),
      );
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue({ id: 'pay_1' });

      const res: any = await svc.prepare(p);
      expect(res.error).toBe(0);
      expect(res.merchant_prepare_id).toBeTruthy();
    });

    it('prepare rejects a bad signature (-1)', async () => {
      const svc = new ClickService(prisma, config, settlement as any);
      const res: any = await svc.prepare({
        click_trans_id: '777',
        service_id: '12345',
        merchant_trans_id: 'ord_1',
        amount: 215000,
        action: 0,
        sign_time: 't',
        sign_string: 'deadbeef',
      });
      expect(res.error).toBe(-1);
    });

    it('complete settles a prepared payment on action=1', async () => {
      const svc = new ClickService(prisma, config, settlement as any);
      const p: Record<string, any> = {
        click_trans_id: '777',
        service_id: '12345',
        merchant_trans_id: 'ord_1',
        merchant_prepare_id: '1700',
        amount: 215000,
        action: 1,
        error: 0,
        sign_time: '2026-06-14 10:01:00',
      };
      p.sign_string = sign(p, true);
      prisma.payment.findFirst.mockResolvedValue({
        id: 'pay_1',
        providerPrepareId: '1700',
        status: 'PENDING',
      });

      const res: any = await svc.complete(p);
      expect(res.error).toBe(0);
      expect(settlement.markPaid).toHaveBeenCalledWith('pay_1');
    });
  });
});
