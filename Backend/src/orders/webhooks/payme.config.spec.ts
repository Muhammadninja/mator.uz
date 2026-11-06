import {
  collectPaymeConfigErrors,
  validatePaymeEnv,
  readPaymeConfig,
  readPaymeFiscalConfig,
  DELIVERY_FISCAL_CODES,
  DELIVERY_VAT_RATE,
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

  it('is nothing at all when it is not configured: never an assumed 0', () => {
    expect(rate()).toBeNull();
  });

  it.each(['', ' ', 'abc', '12%', '-1', '101', 'NaN', 'Infinity'])(
    'is nothing at all for %j: not a percentage',
    (value) => {
      expect(rate(value)).toBeNull();
    },
  );

  it.each([
    ['0', 0],
    ['6', 6],
    ['12', 12],
    ['12.5', 12.5],
    ['100', 100],
  ])('is exactly what was stated: %s', (value, expected) => {
    expect(rate(value)).toBe(expected);
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
    expect(DELIVERY_VAT_RATE).toBe(0);
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
        'src/admin/orders/admin-orders.presenter.ts', // shows it
        'src/cart/cart.presenter.ts', // states none: only a quote prices delivery
        'src/orders/order-settlement.ts', // keeps it out of what a seller is owed
        'src/orders/order.presenter.ts', // shows it
        'src/orders/orders.service.ts', // the one writer, at creation
        'src/orders/service-fee.util.ts', // adds it to the total, never to the fee
        'src/orders/webhooks/payme-fiscal.service.ts', // reads it for the receipt
      ],
    );
  });
});
