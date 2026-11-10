// LOW-PAY-009 (return URLs) and LOW-PAY-008 (Click ids).

import { ConfigService } from '@nestjs/config';
import {
  assertReturnUrl,
  readReturnUrlPolicy,
  returnUrlProblem,
} from './payment-return-url';
import { buildPaymeCheckoutUrl } from './webhooks/payme-checkout.util';
import {
  clickMerchantIds,
  collectClickConfigErrors,
  isClickEnabled,
} from './webhooks/click.config';
import { collectPaymeConfigErrors } from './webhooks/payme.config';
import { PaymentsService } from './payments.service';

const policyOf = (env: Record<string, string> = {}) =>
  readReturnUrlPolicy((k) => env[k]);
const production = policyOf({ NODE_ENV: 'production' });
const withWeb = policyOf({
  NODE_ENV: 'production',
  PAYMENT_RETURN_URL_HOSTS: 'mator.uz, pay.mator.uz',
});

describe('payment return URL policy', () => {
  it('accepts the app callback the mobile client sends', () => {
    expect(returnUrlProblem('mator://payment-return', production)).toBeNull();
    expect(
      returnUrlProblem('mator://payment-return?order=ord_1', production),
    ).toBeNull();
  });

  it('accepts a web callback on a configured first-party host only', () => {
    expect(
      returnUrlProblem('https://mator.uz/payment/return?o=1', withWeb),
    ).toBeNull();
    expect(
      returnUrlProblem('https://mator.uz/payment/return', production),
    ).toBe('host not allowed');
  });

  it.each([
    'https://evil.example/',
    'https://mator.uz.evil.example/',
    'https://evil.example/?next=https://mator.uz',
    'https://user:pw@mator.uz/',
    'https://mator.uz:8443/',
  ])('refuses the external or disguised host %s', (url) => {
    expect(returnUrlProblem(url, withWeb)).not.toBeNull();
  });

  it.each([
    ['a semicolon', 'mator://payment-return;a=1'],
    ['an encoded semicolon', 'mator://payment-return%3Ba=1'],
    ['a double-encoded semicolon', 'mator://payment-return%253Ba=1'],
    ['CR/LF', 'mator://payment-return\r\nX: y'],
    ['encoded CR/LF', 'mator://payment-return%0d%0aX:y'],
    ['a space', 'mator://payment return'],
    ['a tab', 'mator://payment\treturn'],
    ['a NUL', 'mator://payment\u0000return'],
  ])('refuses %s', (_name, url) => {
    expect(returnUrlProblem(url, withWeb)).toBe('forbidden character');
  });

  it.each([
    ['http', 'http://mator.uz/return'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,x'],
    ['file', 'file:///etc/passwd'],
    ['intent', 'intent://scan/#Intent'],
    ['another app', 'otherapp://payment-return'],
  ])('refuses the %s scheme', (_name, url) => {
    expect(returnUrlProblem(url, withWeb)).toBe('scheme not allowed');
  });

  it.each(['', 'payment-return', '//mator.uz/x', 'mator://%zz'])(
    'refuses the malformed value %j',
    (url) => {
      expect(returnUrlProblem(url, withWeb)).not.toBeNull();
    },
  );

  it('refuses an oversized value', () => {
    expect(returnUrlProblem(`mator://x?${'a'.repeat(600)}`, production)).toBe(
      'too long',
    );
  });

  it('allows the Expo development schemes outside production only', () => {
    const dev = policyOf({});
    const expo = 'exp://192.168.1.5:8081/--/payment-return';
    expect(returnUrlProblem(expo, dev)).toBeNull();
    expect(returnUrlProblem(expo, production)).toBe('scheme not allowed');
  });

  it('an omitted return_url stays omitted; a bad one is a 400 with a code', () => {
    expect(assertReturnUrl(undefined, production)).toBeUndefined();
    try {
      assertReturnUrl('https://evil.example', production);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toMatchObject({
        status: 400,
        response: { code: 'INVALID_RETURN_URL' },
      });
    }
  });

  it('the checkout builder itself refuses a separator in any field', () => {
    const base = {
      merchantId: 'm',
      accountField: 'order_id',
      orderId: 'ord_1',
      amountTiyin: 100,
    };
    expect(() =>
      buildPaymeCheckoutUrl({ ...base, returnUrl: 'mator://x;a=1' }),
    ).toThrow(/separator/);
    expect(() =>
      buildPaymeCheckoutUrl({ ...base, orderId: 'o;a=1' }),
    ).toThrow();
    // And the valid link is unchanged in shape.
    const url = buildPaymeCheckoutUrl({
      ...base,
      returnUrl: 'mator://payment-return',
    });
    expect(Buffer.from(url.split('/').pop()!, 'base64').toString()).toBe(
      'm=m;ac.order_id=ord_1;a=100;c=mator://payment-return',
    );
  });
});

describe('PaymentsService invoices', () => {
  function build(env: Record<string, string>) {
    const prisma = {
      order: { findUnique: jest.fn() },
      payment: { create: jest.fn() },
    };
    const config = { get: (k: string) => env[k] } as unknown as ConfigService;
    const fiscal = { buildOrderDetail: jest.fn() };
    return {
      service: new PaymentsService(prisma as never, config, fiscal as never),
      prisma,
    };
  }

  it('refuses a bad return_url before the order is even read', async () => {
    const { service, prisma } = build({ NODE_ENV: 'production' });
    await expect(
      service.createPaymeInvoice('usr_1', {
        order_id: 'ord_1',
        return_url: 'https://evil.example/;a=1',
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_RETURN_URL' } });
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('Click stays disabled by default and creates nothing', async () => {
    const { service, prisma } = build({});
    await expect(
      service.createClickInvoice('usr_1', { order_id: 'ord_1' }),
    ).rejects.toThrow('Click payments are not enabled');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('Click enabled without real ids hands out no link (no placeholder fallback)', async () => {
    const { service, prisma } = build({
      PAYMENT_PROVIDERS: 'payme,click',
      CLICK_SECRET_KEY: 'secret',
    });
    await expect(
      service.createClickInvoice('usr_1', { order_id: 'ord_1' }),
    ).rejects.toThrow('Click payments are not enabled');
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});

describe('Click configuration', () => {
  const enabled = { PAYMENT_PROVIDERS: 'payme,click', CLICK_SECRET_KEY: 's' };
  const get = (env: Record<string, string>) => (k: string) => env[k];

  it('is disabled by default, and a secret or ids alone do not enable it', () => {
    expect(isClickEnabled(get({}))).toBe(false);
    expect(isClickEnabled(get({ CLICK_SECRET_KEY: 's' }))).toBe(false);
    expect(
      isClickEnabled(
        get({ CLICK_SERVICE_ID: '98321', CLICK_MERCHANT_ID: '44790' }),
      ),
    ).toBe(false);
    // Disabled Click is never a boot error, whatever its ids say.
    expect(collectClickConfigErrors({ CLICK_SERVICE_ID: '12345' })).toEqual([]);
  });

  it('enabled without ids fails validation', () => {
    expect(collectClickConfigErrors(enabled)).toHaveLength(2);
  });

  it.each([
    ['12345', '67890'],
    ['12345', '44790'],
    ['98321', '67890'],
    ['abc', '44790'],
    ['', ''],
  ])(
    'enabled with placeholder or malformed ids %j / %j fails validation',
    (s, m) => {
      const env = { ...enabled, CLICK_SERVICE_ID: s, CLICK_MERCHANT_ID: m };
      expect(collectClickConfigErrors(env).length).toBeGreaterThan(0);
      expect(clickMerchantIds(get(env))).toBeNull();
    },
  );

  it('enabled with real ids passes', () => {
    const env = {
      ...enabled,
      CLICK_SERVICE_ID: '98321',
      CLICK_MERCHANT_ID: '44790',
    };
    expect(collectClickConfigErrors(env)).toEqual([]);
    expect(clickMerchantIds(get(env))).toEqual({
      serviceId: '98321',
      merchantId: '44790',
    });
  });

  it('Payme validation is unaffected by any Click setting', () => {
    const payme = {
      NODE_ENV: 'production',
      PAYME_MERCHANT_ID: 'm',
      PAYME_MERCHANT_KEY: 'k',
    };
    expect(collectPaymeConfigErrors({ ...payme, ...enabled })).toEqual(
      collectPaymeConfigErrors(payme),
    );
  });
});
