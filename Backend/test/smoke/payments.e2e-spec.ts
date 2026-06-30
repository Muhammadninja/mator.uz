import { createHash } from 'crypto';
import { PaymentsService } from '../../src/orders/payments.service';
import { PaymeService } from '../../src/orders/webhooks/payme.service';
import { ClickService } from '../../src/orders/webhooks/click.service';
import { createPrismaMock, fakeConfig, buildOrder, PrismaMock } from '../utils/harness';

describe('Payments + webhooks smoke', () => {
  let prisma: PrismaMock;
  let settlement: { markPaid: jest.Mock; markCancelled: jest.Mock };
  beforeEach(() => {
    prisma = createPrismaMock();
    settlement = { markPaid: jest.fn().mockResolvedValue(undefined), markCancelled: jest.fn().mockResolvedValue(undefined) };
  });

  describe('Invoices', () => {
    it('builds a Payme invoice with deep link + tiyin amount', async () => {
      const svc = new PaymentsService(prisma, fakeConfig());
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ id: 'ord_1', userId: 'usr_1', status: 'PENDING_PAYMENT', totalUzs: 215000 }),
      );
      prisma.payment.create.mockResolvedValue({ id: 'pay_1' });

      const res = await svc.createPaymeInvoice('usr_1', { order_id: 'ord_1' } as any);
      expect(res.payment_id).toBe('pay_1');
      expect(res.amount_tiyin).toBe(21_500_000);
      expect(res.deep_link).toContain('payme://merchant/ord_1');
    });

    it('refuses to invoice an order that is not awaiting payment', async () => {
      const svc = new PaymentsService(prisma, fakeConfig());
      prisma.order.findUnique.mockResolvedValue(buildOrder({ userId: 'usr_1', status: 'PAID' }));
      await expect(svc.createPaymeInvoice('usr_1', { order_id: 'ord_1' } as any)).rejects.toThrow(/awaiting payment/);
    });
  });

  describe('Payme JSON-RPC', () => {
    const KEY = 'merchant-secret';
    const auth = 'Basic ' + Buffer.from(`Paycom:${KEY}`).toString('base64');
    const config = fakeConfig({ PAYME_MERCHANT_KEY: KEY, PAYME_ACCOUNT_FIELD: 'order_id' });

    it('rejects a request with a bad merchant key (-32504)', async () => {
      const svc = new PaymeService(prisma, config, settlement as any);
      const res: any = await svc.handle('Basic wrong', { id: 1, method: 'CheckPerformTransaction', params: {} });
      expect(res.error.code).toBe(-32504);
    });

    it('CheckPerformTransaction allows a valid pending order', async () => {
      const svc = new PaymeService(prisma, config, settlement as any);
      prisma.order.findUnique.mockResolvedValue(buildOrder({ id: 'ord_1', status: 'PENDING_PAYMENT', totalUzs: 215000 }));
      const res: any = await svc.handle(auth, {
        id: 1,
        method: 'CheckPerformTransaction',
        params: { account: { order_id: 'ord_1' }, amount: 21_500_000 },
      });
      expect(res.result).toEqual({ allow: true });
    });

    it('rejects an incorrect amount (-31001)', async () => {
      const svc = new PaymeService(prisma, config, settlement as any);
      prisma.order.findUnique.mockResolvedValue(buildOrder({ id: 'ord_1', status: 'PENDING_PAYMENT', totalUzs: 215000 }));
      const res: any = await svc.handle(auth, {
        id: 1,
        method: 'CheckPerformTransaction',
        params: { account: { order_id: 'ord_1' }, amount: 999 },
      });
      expect(res.error.code).toBe(-31001);
    });

    it('CreateTransaction then PerformTransaction settles the payment (state 1 → 2)', async () => {
      const svc = new PaymeService(prisma, config, settlement as any);
      // CreateTransaction: no existing/active/bindable payment -> create fresh.
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.order.findUnique.mockResolvedValue(buildOrder({ id: 'ord_1', status: 'PENDING_PAYMENT', totalUzs: 215000 }));
      prisma.payment.create.mockResolvedValue({ id: 'pay_1' });

      const created: any = await svc.handle(auth, {
        id: 1,
        method: 'CreateTransaction',
        params: { id: 'pmt-xyz', time: 1700000000000, amount: 21_500_000, account: { order_id: 'ord_1' } },
      });
      expect(created.result).toEqual(expect.objectContaining({ transaction: 'pay_1', state: 1 }));

      // PerformTransaction: payment found in state 1 -> markPaid + state 2.
      prisma.payment.findFirst.mockResolvedValue({ id: 'pay_1', providerState: 1 });
      const performed: any = await svc.handle(auth, { id: 2, method: 'PerformTransaction', params: { id: 'pmt-xyz' } });
      expect(performed.result).toEqual(expect.objectContaining({ transaction: 'pay_1', state: 2 }));
      expect(settlement.markPaid).toHaveBeenCalledWith('pay_1', expect.any(Number));
    });
  });

  describe('Click', () => {
    const SECRET = 'click-secret';
    const config = fakeConfig({ CLICK_SECRET_KEY: SECRET });

    function sign(p: Record<string, any>, isComplete: boolean) {
      const parts = [p.click_trans_id, p.service_id, SECRET, p.merchant_trans_id];
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
      prisma.order.findUnique.mockResolvedValue(buildOrder({ id: 'ord_1', status: 'PENDING_PAYMENT', totalUzs: 215000 }));
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue({ id: 'pay_1' });

      const res: any = await svc.prepare(p);
      expect(res.error).toBe(0);
      expect(res.merchant_prepare_id).toBeTruthy();
    });

    it('prepare rejects a bad signature (-1)', async () => {
      const svc = new ClickService(prisma, config, settlement as any);
      const res: any = await svc.prepare({ click_trans_id: '777', service_id: '12345', merchant_trans_id: 'ord_1', amount: 215000, action: 0, sign_time: 't', sign_string: 'deadbeef' });
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
      prisma.payment.findFirst.mockResolvedValue({ id: 'pay_1', providerPrepareId: '1700', status: 'PENDING' });

      const res: any = await svc.complete(p);
      expect(res.error).toBe(0);
      expect(settlement.markPaid).toHaveBeenCalledWith('pay_1');
    });
  });
});
