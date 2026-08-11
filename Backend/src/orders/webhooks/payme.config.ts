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
/**
 * Fiscal codes for the PLATFORM's own charges — the lines a receipt needs
 * beyond the goods, so its total matches what the customer is charged.
 *
 * Read from configuration rather than hardcoded because they are the
 * marketplace's own classification, not a category's: an operator registers the
 * business's services in Tasnif and puts the resulting codes here. Delivery
 * ships with the courier-service defaults below; the service fee ships with
 * NONE, so an order carrying one is refused with a message naming these keys
 * rather than fiscalized under a code that describes delivery.
 *
 * Names are unprefixed to sit beside the charges they describe
 * (DELIVERY_COURIER_UZS, SERVICE_FEE_UZS), which is where an operator will look.
 */
export interface PaymeFiscalConfig {
  delivery: PlatformChargeFiscal;
  serviceFee: PlatformChargeFiscal;
  /** The marketplace's own ИНН, attached to platform lines. Null ⇒ omitted. */
  marketplaceTin: string | null;
}

export interface PlatformChargeFiscal {
  mxik: string | null;
  packageCode: string | null;
  vatPercent: number;
}

/** Courier/delivery services. Overridable per deployment. */
export const DEFAULT_DELIVERY_MXIK = '05320001001000000';
export const DEFAULT_DELIVERY_PACKAGE_CODE = '1000000';

export function readPaymeFiscalConfig(
  get: (key: string) => string | undefined,
): PaymeFiscalConfig {
  const percent = (key: string): number => {
    const raw = asTrimmedString(get(key));
    const parsed = Number(raw);
    // An unset or unparseable rate is 0, never a guess: the platform's own
    // services are VAT-exempt unless an operator states otherwise.
    return raw && Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    delivery: {
      mxik: asTrimmedString(get('DELIVERY_MXIK')) || DEFAULT_DELIVERY_MXIK,
      packageCode:
        asTrimmedString(get('DELIVERY_PACKAGE_CODE')) ||
        DEFAULT_DELIVERY_PACKAGE_CODE,
      vatPercent: percent('DELIVERY_VAT_PERCENT'),
    },
    serviceFee: {
      // No default: the marketplace's service fee is a different service from
      // delivery, and reusing delivery's code would mis-declare it.
      mxik: asTrimmedString(get('SERVICE_FEE_MXIK')) || null,
      packageCode: asTrimmedString(get('SERVICE_FEE_PACKAGE_CODE')) || null,
      vatPercent: percent('SERVICE_FEE_VAT_PERCENT'),
    },
    marketplaceTin: asTrimmedString(get('MARKETPLACE_TIN')) || null,
  };
}

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
