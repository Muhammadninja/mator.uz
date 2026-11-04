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
