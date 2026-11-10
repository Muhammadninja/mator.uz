import {
  collectPaymeConfigErrors,
  collectPaymeFiscalReadinessErrors,
  validatePaymeEnv,
  readPaymeConfig,
  readPaymeFiscalConfig,
  DELIVERY_FISCAL_CODES,
  MARKETPLACE_VAT_RATE,
  YANDEX_GO_TIN,
  DEFAULT_PAYME_CHECKOUT_URL,
  DEFAULT_PAYME_ACCOUNT_FIELD,
} from './payme.config';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { MXIK_PATTERN, PACKAGE_CODE_PATTERN } from '../../common/fiscal.util';

/**
 * The webhook's only defence is the merchant key, so a deploy that loses it must
 * fail loudly at boot rather than serve an endpoint whose Basic auth anyone can
 * reproduce.
 */
describe('Payme configuration validation', () => {
  const prod = { NODE_ENV: 'production' };

  it('accepts a complete production configuration', () => {
    expect(
      collectPaymeConfigErrors({
        ...prod,
        PAYME_MERCHANT_ID: 'merchant-1',
        PAYME_MERCHANT_KEY: 'secret',
      }),
    ).toEqual([]);
  });

  it('rejects a missing merchant key in production', () => {
    const errors = collectPaymeConfigErrors({
      ...prod,
      PAYME_MERCHANT_ID: 'merchant-1',
    });
    expect(errors.join(' ')).toContain('PAYME_MERCHANT_KEY is required');
  });

  it('rejects a missing merchant id in production', () => {
    const errors = collectPaymeConfigErrors({
      ...prod,
      PAYME_MERCHANT_KEY: 'secret',
    });
    expect(errors.join(' ')).toContain('PAYME_MERCHANT_ID is required');
  });

  it('rejects a present-but-blank key in ANY environment', () => {
    // The dangerous case: the variable exists, so a naive check passes, but the
    // expected auth header collapses to a publicly computable value.
    const errors = collectPaymeConfigErrors({
      NODE_ENV: 'development',
      PAYME_MERCHANT_KEY: '   ',
    });
    expect(errors.join(' ')).toContain('refusing to start');
  });

  it('rejects a non-https checkout url', () => {
    const errors = collectPaymeConfigErrors({
      ...prod,
      PAYME_MERCHANT_ID: 'm',
      PAYME_MERCHANT_KEY: 'k',
      PAYME_CHECKOUT_URL: 'http://checkout.paycom.uz',
    });
    expect(errors.join(' ')).toContain('must use https');
  });

  it('rejects a malformed checkout url', () => {
    const errors = collectPaymeConfigErrors({
      ...prod,
      PAYME_MERCHANT_ID: 'm',
      PAYME_MERCHANT_KEY: 'k',
      PAYME_CHECKOUT_URL: 'not a url',
    });
    expect(errors.join(' ')).toContain('not a valid URL');
  });

  it('allows a development boot with no Payme settings at all', () => {
    expect(collectPaymeConfigErrors({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('throws from the ConfigModule hook so bootstrap aborts', () => {
    expect(() => validatePaymeEnv({ ...prod, PAYME_MERCHANT_ID: 'm' })).toThrow(
      /Invalid Payme configuration/,
    );
  });

  it('materialises defaults for checkout url and account field', () => {
    const env = validatePaymeEnv({ NODE_ENV: 'development' });
    expect(env.PAYME_CHECKOUT_URL).toBe(DEFAULT_PAYME_CHECKOUT_URL);
    expect(env.PAYME_ACCOUNT_FIELD).toBe(DEFAULT_PAYME_ACCOUNT_FIELD);
  });

  it('keeps an explicitly configured sandbox checkout url', () => {
    const env = validatePaymeEnv({
      NODE_ENV: 'development',
      PAYME_CHECKOUT_URL: 'https://test.paycom.uz',
    });
    expect(env.PAYME_CHECKOUT_URL).toBe('https://test.paycom.uz');
  });

  it('reads settings back, trimming stray whitespace', () => {
    const map: Record<string, string> = {
      PAYME_MERCHANT_ID: ' merchant-1 ',
      PAYME_MERCHANT_KEY: ' secret ',
    };
    const cfg = readPaymeConfig((k) => map[k]);
    expect(cfg).toEqual({
      merchantId: 'merchant-1',
      merchantKey: 'secret',
      checkoutUrl: DEFAULT_PAYME_CHECKOUT_URL,
      accountField: DEFAULT_PAYME_ACCOUNT_FIELD,
    });
  });
});

describe('PAYME_ALLOW_SERVICE_ONLY_ORDERS', () => {
  const read = (value?: string) =>
    readPaymeFiscalConfig((key) =>
      key === 'PAYME_ALLOW_SERVICE_ONLY_ORDERS' ? value : undefined,
    ).allowServiceOnlyOrders;

  it('is off when the variable is absent', () => {
    expect(read()).toBe(false);
  });

  it.each(['false', '', ' ', 'TRUE', 'True', '1', 'yes', 'on'])(
    'is off for %j: only the exact word turns it on',
    (value) => {
      expect(read(value)).toBe(false);
    },
  );

  it('is on for exactly `true`', () => {
    expect(read('true')).toBe(true);
    expect(read(' true ')).toBe(true);
  });
});

describe('the service fee’s VAT rate', () => {
  const rate = (value?: string) =>
    readPaymeFiscalConfig((key) =>
      key === 'SERVICE_FEE_VAT_PERCENT' ? value : undefined,
    ).serviceFee.vatPercent;

  it('is Mator’s own rate, 0: the fee is Mator’s income and Mator is not a VAT payer', () => {
    expect(rate()).toBe(0);
    expect(rate()).toBe(MARKETPLACE_VAT_RATE);
  });

  it.each(['12', '15', '4', '0', '', 'abc'])(
    'stays 0 whatever SERVICE_FEE_VAT_PERCENT says: %j',
    (value) => {
      expect(rate(value)).toBe(0);
    },
  );

  it('is always the same rate as delivery’s: one company, one tax status', () => {
    const { delivery, serviceFee } = readPaymeFiscalConfig(() => '12');
    expect(serviceFee.vatPercent).toBe(delivery.vatPercent);
  });
});

describe('the marketplace’s tax id', () => {
  const tin = (value?: string) =>
    readPaymeFiscalConfig((key) =>
      key === 'MARKETPLACE_TIN' ? value : undefined,
    ).marketplaceTin;

  it('is the company’s 9-digit ИНН, as stated', () => {
    expect(tin('123456789')).toBe('123456789');
    expect(tin(' 123456789 ')).toBe('123456789');
    // Leading zeros carry meaning, which is why it stays a string.
    expect(tin('012345678')).toBe('012345678');
  });

  it('is nothing at all when it is not configured', () => {
    expect(tin()).toBeNull();
    expect(tin('')).toBeNull();
    expect(tin('   ')).toBeNull();
  });

  it.each([
    ['too short', '12345678'],
    ['too long', '1234567890'],
    ['a person’s ПИНФЛ: Mator is an ООО', '12345678901234'],
    ['not digits', 'MATOR'],
    ['a stray character', '12345678O'],
  ])('is nothing at all when it is %s', (_, value) => {
    expect(tin(value)).toBeNull();
  });

  it('is never YandexGo’s', () => {
    expect(YANDEX_GO_TIN).toBe('309457999');
    expect(tin('309457999')).toBeNull();
    expect(tin(' 309457999 ')).toBeNull();
  });
});

describe('delivery’s fiscal codes', () => {
  it('are the ones the business decided on, in a form a receipt can carry', () => {
    expect(DELIVERY_FISCAL_CODES).toEqual({
      mxik: '10112006002000000',
      packageCode: '1542432',
    });
    expect(DELIVERY_FISCAL_CODES.mxik).toMatch(MXIK_PATTERN);
    expect(DELIVERY_FISCAL_CODES.packageCode).toMatch(PACKAGE_CODE_PATTERN);
  });

  it('are not configuration: whatever the environment says, they stay', () => {
    const { delivery } = readPaymeFiscalConfig((key) =>
      key === 'DELIVERY_MXIK'
        ? '05320001001000000'
        : key === 'DELIVERY_PACKAGE_CODE'
          ? '1000000'
          : undefined,
    );
    expect(delivery).toMatchObject({
      mxik: '10112006002000000',
      packageCode: '1542432',
    });
  });

  it('carry a VAT rate of 0: Mator pays turnover tax and is not registered for VAT', () => {
    expect(MARKETPLACE_VAT_RATE).toBe(0);
    expect(readPaymeFiscalConfig(() => undefined).delivery.vatPercent).toBe(
      MARKETPLACE_VAT_RATE,
    );
  });

  it.each([undefined, '', '12', '4', 'abc'])(
    'keep that rate whatever the environment says: %j',
    (value) => {
      const { delivery } = readPaymeFiscalConfig((key) =>
        key === 'DELIVERY_VAT_PERCENT' ? value : undefined,
      );
      expect(delivery.vatPercent).toBe(0);
    },
  );

  const backend = join(__dirname, '..', '..', '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : [join(dir, entry.name)],
    );
  const filesMatching = (pattern: RegExp, dirs: string[]) =>
    dirs
      .flatMap((dir) => walk(join(backend, dir)))
      .filter((file) => /\.(ts|sql)$/.test(file))
      .filter((file) => !/\.spec\.ts$/.test(file))
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(backend, file));

  it('the old code and the keys that could set it are gone from the code', () => {
    expect(
      filesMatching(
        /05320001001000000|DELIVERY_MXIK|DELIVERY_PACKAGE_CODE|DEFAULT_DELIVERY_MXIK/,
        ['src', 'scripts', 'prisma'],
      ),
    ).toEqual([]);
  });

  it('nothing reads a VAT rate for delivery from the environment', () => {
    expect(filesMatching(/DELIVERY_VAT_PERCENT/, ['src', 'scripts'])).toEqual(
      [],
    );
  });

  it('nothing reads a VAT rate for the service fee from the environment either', () => {
    expect(
      filesMatching(/SERVICE_FEE_VAT_PERCENT/, ['src', 'scripts']),
    ).toEqual([]);
  });

  it('YandexGo’s tax id is named once, to refuse it', () => {
    expect(filesMatching(/309457999/, ['src', 'scripts', 'prisma'])).toEqual([
      'src/orders/webhooks/payme.config.ts',
    ]);
  });

  it('nothing reads a flat delivery price or a service fee from the environment', () => {
    expect(
      filesMatching(
        /DELIVERY_COURIER_UZS|DEFAULT_COURIER_UZS|SERVICE_FEE_UZS/,
        ['src', 'scripts'],
      ),
    ).toEqual([]);
  });

  it('the stored delivery cost has one writer: a new reader or writer has to be looked at', () => {
    expect(filesMatching(/\bdeliveryUzs\b/, ['src', 'scripts']).sort()).toEqual(
      [
        'src/admin/finance/admin-finance-checks.service.ts', // shows an order's charges
        'src/admin/finance/admin-finance.service.ts', // sums it, as Mator's line
        'src/admin/orders/admin-orders.presenter.ts', // shows it
        'src/admin/refunds/admin-refunds.presenter.ts', // a refund's share of it
        'src/admin/refunds/admin-refunds.service.ts', // a refund's share of it
        'src/admin/refunds/dto/record-refund.dto.ts', // a refund's share of it
        'src/cart/cart.presenter.ts', // states none: only a quote prices delivery
        'src/orders/financial-refund.ledger.ts', // what of it went back
        'src/orders/order-settlement.ts', // keeps it out of what a seller is owed
        'src/orders/order.presenter.ts', // shows it
        'src/orders/orders.service.ts', // the one writer, at creation
        'src/orders/refund-breakdown.ts', // what of it can still go back
        'src/orders/service-fee.util.ts', // adds it to the total, never to the fee
        'src/orders/webhooks/payme-fiscal.service.ts', // reads it for the receipt
        'src/orders/webhooks/settlement-store.test-util.ts', // a test double's column
      ],
    );
  });

  // INFO-4: sandbox and production are declared, and the checkout host is pinned.
  describe('environment and checkout host', () => {
    const prod = {
      NODE_ENV: 'production',
      PAYME_MERCHANT_ID: 'm',
      PAYME_MERCHANT_KEY: 'k',
    };

    it('production accepts the production checkout host, set or defaulted', () => {
      expect(collectPaymeConfigErrors(prod)).toEqual([]);
      expect(
        collectPaymeConfigErrors({
          ...prod,
          PAYME_ENV: 'production',
          PAYME_CHECKOUT_URL: 'https://checkout.paycom.uz',
        }),
      ).toEqual([]);
    });

    it('production refuses PAYME_ENV=sandbox', () => {
      expect(
        collectPaymeConfigErrors({ ...prod, PAYME_ENV: 'sandbox' }).join(' '),
      ).toMatch(/PAYME_ENV=sandbox is refused/);
    });

    it.each(['https://test.paycom.uz', 'https://checkout.test.paycom.uz'])(
      'production refuses the sandbox checkout host %s, even if someone lists it',
      (url) => {
        expect(
          collectPaymeConfigErrors({
            ...prod,
            PAYME_CHECKOUT_URL: url,
            PAYME_CHECKOUT_ALLOWED_HOSTS: new URL(url).host,
          }).join(' '),
        ).toMatch(/not an accepted Payme checkout host/);
      },
    );

    it.each([
      'https://checkout.paycom.uz.evil.example',
      'https://evil.example/checkout.paycom.uz',
      'https://user:pass@checkout.paycom.uz',
      'https://checkout.paycom.uz:8443',
    ])('refuses %s: https alone is not trust', (url) => {
      expect(
        collectPaymeConfigErrors({ ...prod, PAYME_CHECKOUT_URL: url }),
      ).toHaveLength(1);
      expect(
        collectPaymeConfigErrors({
          NODE_ENV: 'development',
          PAYME_CHECKOUT_URL: url,
        }),
      ).toHaveLength(1);
    });

    it('accepts another host only when PAYME_CHECKOUT_ALLOWED_HOSTS names it', () => {
      expect(
        collectPaymeConfigErrors({
          ...prod,
          PAYME_CHECKOUT_URL: 'https://pay.example.uz',
          PAYME_CHECKOUT_ALLOWED_HOSTS: 'pay.example.uz',
        }),
      ).toEqual([]);
    });

    it('rejects an unknown PAYME_ENV value', () => {
      expect(
        collectPaymeConfigErrors({ NODE_ENV: 'development', PAYME_ENV: 'live' }),
      ).toEqual(['PAYME_ENV must be "production" or "sandbox".']);
    });
  });

  // INFO-15: fiscal configuration at boot.
  describe('fiscal readiness', () => {
    const base = { NODE_ENV: 'production', PAYME_MERCHANT_ID: 'm', PAYME_MERCHANT_KEY: 'k' };

    it('does not block startup by default, whatever is missing', () => {
      expect(collectPaymeFiscalReadinessErrors(base)).toEqual([]);
      expect(() => validatePaymeEnv(base)).not.toThrow();
    });

    it('with PAYME_FISCAL_REQUIRED=true, refuses to start and names each missing value', () => {
      const errors = collectPaymeFiscalReadinessErrors({ ...base, PAYME_FISCAL_REQUIRED: 'true' });
      expect(errors.join(' ')).toMatch(/MARKETPLACE_TIN/);
      expect(errors.join(' ')).toMatch(/SERVICE_FEE_MXIK/);
      expect(errors.join(' ')).toMatch(/SERVICE_FEE_PACKAGE_CODE/);
      expect(() => validatePaymeEnv({ ...base, PAYME_FISCAL_REQUIRED: 'true' })).toThrow(
        /Invalid Payme configuration/,
      );
    });

    it('refuses invented or borrowed codes too, not only absent ones', () => {
      const errors = collectPaymeFiscalReadinessErrors({
        ...base,
        PAYME_FISCAL_REQUIRED: 'true',
        MARKETPLACE_TIN: '309457999', // YandexGo's, never Mator's
        SERVICE_FEE_MXIK: '10112006002000000', // delivery's code
        SERVICE_FEE_PACKAGE_CODE: '1542432', // delivery's code
      });
      expect(errors).toHaveLength(3);
    });

    it('passes when all three are real', () => {
      expect(
        collectPaymeFiscalReadinessErrors({
          ...base,
          PAYME_FISCAL_REQUIRED: 'true',
          MARKETPLACE_TIN: '312345678',
          SERVICE_FEE_MXIK: '10305001001000000',
          SERVICE_FEE_PACKAGE_CODE: '1501110',
        }),
      ).toEqual([]);
    });
  });
});
