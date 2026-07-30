/**
 * Payme configuration, validated once at boot.
 *
 * The merchant key is the ONLY thing standing between the public webhook and
 * an attacker able to move orders to PAID: {@link PaymeService} authorizes every
 * JSON-RPC call with `Basic base64("Paycom:" + key)`. An unset key used to fall
 * back to `''`, which turns that check into `Basic base64("Paycom:")` — a value
 * anyone can compute. So an absent/blank key is a boot failure, not a default.
 *
 * Validation is wired into `ConfigModule.forRoot({ validate })`, which runs
 * before any provider is instantiated: a misconfigured deploy dies during
 * bootstrap instead of serving an open webhook.
 */

/** Official Payme checkout host — used when PAYME_CHECKOUT_URL is not set. */
export const DEFAULT_PAYME_CHECKOUT_URL = 'https://checkout.paycom.uz';

/** Account field Payme sends inside `params.account` (configurable per merchant). */
export const DEFAULT_PAYME_ACCOUNT_FIELD = 'order_id';

export interface PaymeConfig {
  merchantId: string;
  merchantKey: string;
  checkoutUrl: string;
  accountField: string;
}

/**
 * Whether Payme settings must be present. Payme is a production payment rail;
 * in tests and local development the app has to boot without merchant
 * credentials, so requirement is scoped to NODE_ENV=production.
 */
function paymeRequired(env: Record<string, unknown>): boolean {
  return env.NODE_ENV === 'production';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate the Payme block of the environment. Returns the collected error
 * messages; an empty array means the configuration is usable.
 *
 * Only Payme keys are inspected — every other environment variable is left
 * untouched so this can be introduced without auditing the entire env surface.
 */
export function collectPaymeConfigErrors(
  env: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const required = paymeRequired(env);

  const merchantId = asTrimmedString(env.PAYME_MERCHANT_ID);
  const merchantKey = asTrimmedString(env.PAYME_MERCHANT_KEY);

  if (required && !merchantId) {
    errors.push(
      'PAYME_MERCHANT_ID is required in production and must not be empty.',
    );
  }
  if (required && !merchantKey) {
    errors.push(
      'PAYME_MERCHANT_KEY is required in production and must not be empty.',
    );
  }

  // A key that is present but blank is always fatal: it silently degrades the
  // webhook's Basic auth into a publicly computable value.
  if (env.PAYME_MERCHANT_KEY !== undefined && !merchantKey) {
    errors.push(
      'PAYME_MERCHANT_KEY is set but empty — refusing to start with an unauthenticated Payme webhook.',
    );
  }
  if (env.PAYME_MERCHANT_ID !== undefined && !merchantId) {
    errors.push('PAYME_MERCHANT_ID is set but empty.');
  }

  const checkoutUrl = asTrimmedString(env.PAYME_CHECKOUT_URL);
  if (checkoutUrl) {
    try {
      const parsed = new URL(checkoutUrl);
      if (parsed.protocol !== 'https:') {
        errors.push('PAYME_CHECKOUT_URL must use https.');
      }
    } catch {
      errors.push(`PAYME_CHECKOUT_URL is not a valid URL: "${checkoutUrl}".`);
    }
  }

  return errors;
}

/**
 * ConfigModule `validate` hook. Throws (aborting bootstrap) when the Payme
 * block is unusable, and otherwise returns the environment with the Payme
 * defaults materialised so `ConfigService.get` sees them.
 */
export function validatePaymeEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const errors = collectPaymeConfigErrors(env);
  if (errors.length > 0) {
    throw new Error(
      `Invalid Payme configuration:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return {
    ...env,
    PAYME_CHECKOUT_URL:
      asTrimmedString(env.PAYME_CHECKOUT_URL) || DEFAULT_PAYME_CHECKOUT_URL,
    PAYME_ACCOUNT_FIELD:
      asTrimmedString(env.PAYME_ACCOUNT_FIELD) || DEFAULT_PAYME_ACCOUNT_FIELD,
  };
}

/**
 * Read the validated Payme settings. `merchantKey` is returned as stored; the
 * caller ({@link PaymeService}) refuses to authorize anything when it is blank,
 * which is the non-production counterpart to the boot-time check above.
 */
export function readPaymeConfig(
  get: (key: string) => string | undefined,
): PaymeConfig {
  return {
    merchantId: asTrimmedString(get('PAYME_MERCHANT_ID')),
    merchantKey: asTrimmedString(get('PAYME_MERCHANT_KEY')),
    checkoutUrl:
      asTrimmedString(get('PAYME_CHECKOUT_URL')) || DEFAULT_PAYME_CHECKOUT_URL,
    accountField:
      asTrimmedString(get('PAYME_ACCOUNT_FIELD')) ||
      DEFAULT_PAYME_ACCOUNT_FIELD,
  };
}
