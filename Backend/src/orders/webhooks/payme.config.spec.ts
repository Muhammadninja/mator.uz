import {
  collectPaymeConfigErrors,
  validatePaymeEnv,
  readPaymeConfig,
  DEFAULT_PAYME_CHECKOUT_URL,
  DEFAULT_PAYME_ACCOUNT_FIELD,
} from './payme.config';

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
