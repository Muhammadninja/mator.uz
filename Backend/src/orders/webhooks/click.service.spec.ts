// Click is NOT a live payment provider: these pin that its existing webhook
// fails closed unless explicitly enabled, so it can never settle a payment —
// in particular not one "signed" with an empty secret. (The successful Click
// flow itself is out of scope.)

import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClickService } from './click.service';
import { PaymentsService } from '../payments.service';
import { AccountService } from '../../account/account.service';

const config = (map: Record<string, string | undefined>) =>
  ({ get: (key: string) => map[key] }) as unknown as ConfigService;

/** Click's MD5 signature, exactly as ClickService.verifySign computes it. */
function sign(p: Record<string, unknown>, secret: string, complete: boolean) {
  const parts = [p.click_trans_id, p.service_id, secret, p.merchant_trans_id];
  if (complete) parts.push(p.merchant_prepare_id);
  parts.push(p.amount, p.action, p.sign_time);
  return createHash('md5').update(parts.join('')).digest('hex');
}

function forged(secret: string, complete: boolean) {
  const p: Record<string, unknown> = {
    click_trans_id: '777',
    service_id: '12345',
    merchant_trans_id: 'ord_1',
    merchant_prepare_id: '1700000000000',
    amount: '215000',
    action: complete ? 1 : 0,
    error: 0,
    sign_time: '2026-10-02 00:00:00',
  };
  return { ...p, sign_string: sign(p, secret, complete) };
}

function build(env: Record<string, string | undefined>) {
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(null) },
    payment: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const settlement = { markPaid: jest.fn(), markCancelled: jest.fn() };
  const svc = new ClickService(
    prisma as never,
    config(env),
    settlement as never,
  );
  return { svc, prisma, settlement };
}

describe('ClickService — fails closed when Click is not enabled', () => {
  it.each([
    ['empty secret', { CLICK_SECRET_KEY: '' }],
    ['missing secret', {}],
    ['blank secret', { CLICK_SECRET_KEY: '   ' }],
  ])(
    '%s: a callback forged with the EMPTY secret is rejected before any DB access',
    async (_label, env) => {
      const { svc, prisma, settlement } = build(env);

      const prep = await svc.prepare(forged('', false));
      const done = await svc.complete(forged('', true));

      expect(prep.error).toBe(-8);
      expect(done.error).toBe(-8);
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(settlement.markPaid).not.toHaveBeenCalled();
    },
  );

  it('PAYMENT_PROVIDERS=payme disables Click even with a secret set', async () => {
    const { svc, prisma, settlement } = build({
      PAYMENT_PROVIDERS: 'payme',
      CLICK_SECRET_KEY: 'real-secret',
    });
    // Correctly signed with the real secret — still refused: Click is off.
    const done = await svc.complete(forged('real-secret', true));
    expect(done.error).toBe(-8);
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    expect(settlement.markPaid).not.toHaveBeenCalled();
  });

  it('when explicitly enabled, a request signed with the WRONG secret is still refused', async () => {
    const { svc, settlement } = build({ CLICK_SECRET_KEY: 'real-secret' });
    const done = await svc.complete(forged('', true));
    expect(done.error).toBe(-1);
    expect(settlement.markPaid).not.toHaveBeenCalled();
  });

  it('when explicitly enabled, a correctly signed prepare reaches the order lookup (control)', async () => {
    const { svc, prisma } = build({ CLICK_SECRET_KEY: 'real-secret' });
    const res = await svc.prepare(forged('real-secret', false));
    expect(prisma.order.findUnique).toHaveBeenCalled();
    expect(res.error).toBe(-5); // order not found in this stub — but not -8
  });
});

describe('Click disabled — no invoices, not listed', () => {
  it('createClickInvoice refuses with 400 when Click is not enabled', async () => {
    const prisma = { order: { findUnique: jest.fn() } };
    const payments = new PaymentsService(
      prisma as never,
      config({}),
      {} as never,
    );
    await expect(
      payments.createClickInvoice('usr_1', { order_id: 'ord_1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    [{}, ['payme']],
    [{ PAYMENT_PROVIDERS: 'payme' }, ['payme']],
    [
      { PAYMENT_PROVIDERS: 'payme,click', CLICK_SECRET_KEY: 's' },
      ['payme', 'click'],
    ],
  ])('payment methods for %j → %j', (env, expected) => {
    const account = new AccountService({} as never, config(env));
    expect(account.paymentMethods().items.map((i) => i.provider)).toEqual(
      expected,
    );
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest matchers are typed `any` */
describe('Click — an order with a service fee', () => {
  const SECRET = 'real-secret';
  // 600 000 of parts, a 20 000 fee and 25 000 of delivery.
  const TOTAL = 645_000;

  function signed(over: Record<string, unknown>, complete: boolean) {
    const p: Record<string, unknown> = {
      click_trans_id: '777',
      service_id: '12345',
      merchant_trans_id: 'ord_1',
      merchant_prepare_id: '1700000000000',
      amount: String(TOTAL),
      action: complete ? 1 : 0,
      error: 0,
      sign_time: '2026-11-06 01:00:00',
      ...over,
    };
    return { ...p, sign_string: sign(p, SECRET, complete) };
  }

  function world() {
    const { svc, prisma, settlement } = build({ CLICK_SECRET_KEY: SECRET });
    prisma.order.findUnique.mockResolvedValue({
      id: 'ord_1',
      status: 'PENDING_PAYMENT',
      totalUzs: TOTAL,
    });
    return { svc, prisma, settlement };
  }

  it('Prepare takes the whole total, fee included, and records exactly that', async () => {
    const { svc, prisma } = world();

    const res = await svc.prepare(signed({}, false));

    expect(res.error).toBe(0);
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountUzs: TOTAL, orderId: 'ord_1' }),
    });
  });

  it.each([
    ['without the fee', 625_000],
    ['without delivery', 620_000],
    ['a tiyin short', 644_999.99],
  ])('Prepare refuses an amount %s (-2)', async (_, amount) => {
    const { svc, prisma } = world();

    const res = await svc.prepare(signed({ amount: String(amount) }, false));

    expect(res.error).toBe(-2);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('a repeated Prepare answers as before and writes no second payment', async () => {
    const { svc, prisma } = world();
    prisma.payment.findFirst.mockResolvedValue({
      id: 'pay_1',
      orderId: 'ord_1',
      status: 'PENDING',
      providerPrepareId: '1700000000000',
    });

    const res = await svc.prepare(signed({}, false));

    expect(res).toMatchObject({
      error: 0,
      merchant_prepare_id: '1700000000000',
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  describe('Complete', () => {
    const prepared = (over: Record<string, unknown> = {}) => ({
      id: 'pay_1',
      orderId: 'ord_1',
      status: 'PENDING',
      amountUzs: TOTAL,
      providerPrepareId: '1700000000000',
      ...over,
    });

    it('settles the payment at the amount Prepare agreed', async () => {
      const { svc, prisma, settlement } = world();
      prisma.payment.findFirst.mockResolvedValue(prepared());
      settlement.markPaid.mockResolvedValue('paid');

      const res = await svc.complete(signed({}, true));

      expect(res.error).toBe(0);
      expect(settlement.markPaid).toHaveBeenCalledWith('pay_1');
    });

    it('refuses an amount other than the one agreed, and settles nothing (-2)', async () => {
      const { svc, prisma, settlement } = world();
      prisma.payment.findFirst.mockResolvedValue(prepared());

      const res = await svc.complete(signed({ amount: '625000' }, true));

      expect(res.error).toBe(-2);
      expect(settlement.markPaid).not.toHaveBeenCalled();
    });

    it('a repeat after success is a success, and settles nothing twice', async () => {
      const { svc, prisma, settlement } = world();
      prisma.payment.findFirst.mockResolvedValue(prepared({ status: 'PAID' }));

      const res = await svc.complete(signed({}, true));

      expect(res.error).toBe(0);
      expect(settlement.markPaid).not.toHaveBeenCalled();
    });

    it.each(['order_not_payable', 'not_settleable', 'not_found'])(
      'never reports success when settlement says %s: Click must give the money back (-9)',
      async (outcome) => {
        const { svc, prisma, settlement } = world();
        prisma.payment.findFirst.mockResolvedValue(prepared());
        settlement.markPaid.mockResolvedValue(outcome);

        const res = await svc.complete(signed({}, true));

        expect(res.error).toBe(-9);
      },
    );

    it('Click’s own failure cancels the payment, refunding nothing that was never taken', async () => {
      const { svc, prisma, settlement } = world();
      prisma.payment.findFirst.mockResolvedValue(prepared());

      const res = await svc.complete(signed({ error: -5017 }, true));

      expect(res.error).toBe(-9);
      expect(settlement.markCancelled).toHaveBeenCalledWith(
        'pay_1',
        -5017,
        false,
      );
      expect(settlement.markPaid).not.toHaveBeenCalled();
    });
  });
});
/* eslint-enable @typescript-eslint/no-unsafe-assignment */
