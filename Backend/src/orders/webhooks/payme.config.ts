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

import { MXIK_PATTERN, PACKAGE_CODE_PATTERN } from '../../common/fiscal.util';

/** Official Payme checkout host — used when PAYME_CHECKOUT_URL is not set. */
export const DEFAULT_PAYME_CHECKOUT_URL = 'https://checkout.paycom.uz';

/**
 * Payme's sandbox hosts: `test.paycom.uz` is the one this project has used for
 * sandbox runs; `checkout.test.paycom.uz` is the sandbox checkout. Usable
 * outside production only: a production process pointed at either would send
 * buyers to a page where no money moves.
 */
export const PAYME_SANDBOX_CHECKOUT_HOSTS = [
  'test.paycom.uz',
  'checkout.test.paycom.uz',
];
const PAYME_PRODUCTION_CHECKOUT_HOST = new URL(DEFAULT_PAYME_CHECKOUT_URL).host;

/**
 * Which Payme a process talks to, stated rather than inferred from a key.
 *
 * A sandbox merchant key and a production one look alike, so nothing can tell
 * them apart by value. What can be checked is that the declared environment,
 * the runtime and the checkout host agree:
 *
 *   • PAYME_ENV is `production` or `sandbox`. Unset, it follows NODE_ENV.
 *   • NODE_ENV=production refuses PAYME_ENV=sandbox and the sandbox host.
 *   • The checkout host is one from an explicit list, never "any https URL":
 *     the production host, the sandbox host (outside production), and any host
 *     named in PAYME_CHECKOUT_ALLOWED_HOSTS.
 *
 * Keep the sandbox credentials in a non-production env file only; that
 * separation is operational and cannot be enforced from here.
 */
export type PaymeEnvironment = 'production' | 'sandbox';

export function resolvePaymeEnvironment(
  env: Record<string, unknown>,
): PaymeEnvironment | null {
  const declared = asTrimmedString(env.PAYME_ENV).toLowerCase();
  if (declared === 'production' || declared === 'sandbox') return declared;
  if (declared) return null;
  return env.NODE_ENV === 'production' ? 'production' : 'sandbox';
}

function allowedCheckoutHosts(
  env: Record<string, unknown>,
  mode: PaymeEnvironment,
): string[] {
  const extra = asTrimmedString(env.PAYME_CHECKOUT_ALLOWED_HOSTS)
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [
    PAYME_PRODUCTION_CHECKOUT_HOST,
    ...(mode === 'sandbox' ? PAYME_SANDBOX_CHECKOUT_HOSTS : []),
    ...extra,
  ];
}

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

  const mode = resolvePaymeEnvironment(env);
  if (!mode) {
    errors.push('PAYME_ENV must be "production" or "sandbox".');
  } else if (required && mode !== 'production') {
    errors.push(
      'PAYME_ENV=sandbox is refused when NODE_ENV=production: buyers would be sent to a checkout where no money moves.',
    );
  }

  const checkoutUrl = asTrimmedString(env.PAYME_CHECKOUT_URL);
  if (checkoutUrl) {
    try {
      const parsed = new URL(checkoutUrl);
      if (parsed.protocol !== 'https:') {
        errors.push('PAYME_CHECKOUT_URL must use https.');
      } else if (parsed.username || parsed.password) {
        errors.push('PAYME_CHECKOUT_URL must not carry credentials.');
      } else if (mode) {
        const host = parsed.host.toLowerCase();
        // In production the sandbox host is never acceptable, listed or not.
        const allowed = allowedCheckoutHosts(
          env,
          required ? 'production' : mode,
        ).filter((h) => !required || !PAYME_SANDBOX_CHECKOUT_HOSTS.includes(h));
        if (!allowed.includes(host)) {
          errors.push(
            `PAYME_CHECKOUT_URL host "${host}" is not an accepted Payme checkout host ` +
              `(${allowed.join(', ')}). Name another in PAYME_CHECKOUT_ALLOWED_HOSTS only if Payme issued it.`,
          );
        }
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
  const errors = [
    ...collectPaymeConfigErrors(env),
    ...collectPaymeFiscalReadinessErrors(env),
  ];
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
 * They are the marketplace's own classification, not a category's, so the console's
 * confirmation does not apply to them. Delivery's are fixed in DELIVERY_FISCAL_CODES.
 * The service fee's are read from configuration, because an operator registers that
 * service in Tasnif and puts the resulting codes here; it ships with NONE, so an order
 * carrying one is refused with a message naming these keys rather than fiscalized
 * under a code that describes delivery.
 *
 * Both are Mator's own lines, so both carry Mator's own VAT rate, MARKETPLACE_VAT_RATE.
 * It follows from Mator's tax status, so no environment variable sets it for either.
 */
export interface PaymeFiscalConfig {
  delivery: PlatformChargeFiscal;
  serviceFee: PlatformChargeFiscal;
  /**
   * Mator's own ИНН, attached to the platform's lines. Null when it is unset or cannot
   * be ours (see readMarketplaceTin), which refuses a delivery or a service fee line.
   */
  marketplaceTin: string | null;
  /**
   * Whether an order made up ONLY of service lines may be paid online at all. Off
   * unless the variable is exactly `true`. Turning it on lifts only that refusal: every
   * line still needs a confirmed classification and its provider's tax data, exactly
   * like goods, so it is no way around any fiscal requirement.
   */
  allowServiceOnlyOrders: boolean;
}

export interface PlatformChargeFiscal {
  mxik: string | null;
  packageCode: string | null;
  /** Mator's own rate, MARKETPLACE_VAT_RATE: the line is Mator's. */
  vatPercent: number;
}

/**
 * Delivery on a receipt, by business decision: the customer pays for it through Payme
 * as part of the order, so it is a line of its own under this system code. It is
 * neither a category's, so nothing in the console confirms it, nor configuration, so
 * no environment can put another code on a receipt. The unit is «услуга (сум)», which
 * the Payme contract carries by its code alone.
 */
export const DELIVERY_FISCAL_CODES = {
  mxik: '10112006002000000',
  packageCode: '1542432',
} as const;

/**
 * Mator's own VAT rate, on every line Mator sells under its own tax id: delivery and the
 * service fee. ООО «MATOR INNOVATIONS» pays turnover tax and is not registered for VAT,
 * so the rate is 0. Turnover tax is a different tax, and its rate never goes in
 * `vat_percent`.
 *
 * One constant for both lines, because it is one fact about one company: the two lines
 * cannot disagree, and no environment can declare a VAT that Mator does not pay.
 * Registering for VAT would be a decision to change this, not a setting. A dealer's own
 * rate (12% at Driver's Village) belongs on that dealer's goods alone.
 */
export const MARKETPLACE_VAT_RATE = 0;

/** A company's ИНН. Mator is an ООО, so a person's 14-digit ПИНФЛ cannot be its own. */
const COMPANY_TIN_PATTERN = /^\d{9}$/;

/**
 * YandexGo's ИНН. Delivery is included in Mator's order and receipt, under Mator's ИНН,
 * and is never recorded in YandexGo's name, so this is refused if it is ever configured.
 */
export const YANDEX_GO_TIN = '309457999';

/** MARKETPLACE_TIN, if it can be Mator's. Anything else counts as not configured. */
function readMarketplaceTin(raw: string | undefined): string | null {
  const tin = asTrimmedString(raw);
  return COMPANY_TIN_PATTERN.test(tin) && tin !== YANDEX_GO_TIN ? tin : null;
}

/**
 * A code for the service fee, if it can be one. Delivery's codes describe delivery, so
 * entering them here counts as not configured: the receipt would declare the fee as a
 * delivery. A malformed code counts the same, since Payme or the tax authority would turn
 * away the receipt after the customer has tapped Pay.
 */
function readServiceFeeCode(
  raw: string | undefined,
  pattern: RegExp,
  deliveryCode: string,
): string | null {
  const code = asTrimmedString(raw);
  return pattern.test(code) && code !== deliveryCode ? code : null;
}

export function readPaymeFiscalConfig(
  get: (key: string) => string | undefined,
): PaymeFiscalConfig {
  return {
    delivery: {
      ...DELIVERY_FISCAL_CODES,
      vatPercent: MARKETPLACE_VAT_RATE,
    },
    serviceFee: {
      // No default: the marketplace's service fee is a different service from
      // delivery, and reusing delivery's code would mis-declare it.
      mxik: readServiceFeeCode(
        get('SERVICE_FEE_MXIK'),
        MXIK_PATTERN,
        DELIVERY_FISCAL_CODES.mxik,
      ),
      packageCode: readServiceFeeCode(
        get('SERVICE_FEE_PACKAGE_CODE'),
        PACKAGE_CODE_PATTERN,
        DELIVERY_FISCAL_CODES.packageCode,
      ),
      // The fee is Mator's income, so it carries Mator's rate, exactly like delivery.
      vatPercent: MARKETPLACE_VAT_RATE,
    },
    marketplaceTin: readMarketplaceTin(get('MARKETPLACE_TIN')),
    allowServiceOnlyOrders:
      asTrimmedString(get('PAYME_ALLOW_SERVICE_ONLY_ORDERS')) === 'true',
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

/**
 * Boot-time fiscal readiness (INFO-15).
 *
 * MARKETPLACE_TIN, SERVICE_FEE_MXIK and SERVICE_FEE_PACKAGE_CODE are needed by
 * any Payme order carrying a delivery cost or a service fee. Without them each
 * such receipt is refused at payment time (fail closed), and the boot log says
 * so. That stays the default: an order with neither charge needs none of them,
 * and refusing to start would take the whole API down for a gap that only
 * affects those orders.
 *
 * With PAYME_FISCAL_REQUIRED=true the process refuses to start instead, naming
 * what is missing. Set it once the codes are registered. Nothing here supplies
 * a value: a missing or malformed code is reported, never defaulted.
 */
export function collectPaymeFiscalReadinessErrors(
  env: Record<string, unknown>,
): string[] {
  if (asTrimmedString(env.PAYME_FISCAL_REQUIRED).toLowerCase() !== 'true') {
    return [];
  }
  const fiscal = readPaymeFiscalConfig((key) =>
    typeof env[key] === 'string' ? env[key] : undefined,
  );
  const errors: string[] = [];
  if (fiscal.marketplaceTin === null) {
    errors.push("MARKETPLACE_TIN must be Mator's 9-digit tax id.");
  }
  if (fiscal.serviceFee.mxik === null) {
    errors.push('SERVICE_FEE_MXIK must be the 17-digit MXIK registered for the service fee.');
  }
  if (fiscal.serviceFee.packageCode === null) {
    errors.push('SERVICE_FEE_PACKAGE_CODE must be the package code registered with that MXIK.');
  }
  return errors.map(
    (e) => `${e} (PAYME_FISCAL_REQUIRED=true refuses to start without it.)`,
  );
}
