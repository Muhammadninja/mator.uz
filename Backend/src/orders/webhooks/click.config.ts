/**
 * Whether the Click provider is ENABLED — the one rule every Click surface
 * (webhook, invoice creation, payment-method listing) consults.
 *
 * Click is not a live payment method for Mator: there is no contract with it
 * yet, and Payme is the only provider. Its code stays, switched off. Its webhook
 * route still exists, and its signature is an MD5 over request fields plus the
 * shared secret: with an empty secret, anyone can compute a valid signature and
 * "confirm" a payment that never happened. So Click is enabled ONLY when both
 *   • it is listed in PAYMENT_PROVIDERS, which by default lists Payme alone, AND
 *   • CLICK_SECRET_KEY is set to a non-blank value.
 * Anything else is disabled and the webhook fails closed. A secret on its own
 * turns nothing on. No new required environment variable.
 */
export const DEFAULT_PAYMENT_PROVIDERS = 'payme';

export function enabledPaymentProviders(
  get: (key: string) => string | undefined,
): string[] {
  return (get('PAYMENT_PROVIDERS') ?? DEFAULT_PAYMENT_PROVIDERS)
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

export function clickSecret(get: (key: string) => string | undefined): string {
  return (get('CLICK_SECRET_KEY') ?? '').trim();
}

export function isClickEnabled(
  get: (key: string) => string | undefined,
): boolean {
  return (
    enabledPaymentProviders(get).includes('click') && clickSecret(get) !== ''
  );
}

/**
 * Values that are not a merchant's own ids. `12345` and `67890` were the
 * placeholders this code used to fall back to: a payment link built from them
 * points at whoever really holds those ids.
 */
const CLICK_PLACEHOLDER_IDS = new Set(['12345', '67890', '0', '123456']);

function clickId(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  return /^\d{1,12}$/.test(value) && !CLICK_PLACEHOLDER_IDS.has(value)
    ? value
    : null;
}

/** Click's service and merchant ids, or null unless BOTH are real. No fallback. */
export function clickMerchantIds(
  get: (key: string) => string | undefined,
): { serviceId: string; merchantId: string } | null {
  const serviceId = clickId(get('CLICK_SERVICE_ID'));
  const merchantId = clickId(get('CLICK_MERCHANT_ID'));
  return serviceId && merchantId ? { serviceId, merchantId } : null;
}

/**
 * Boot-time check (LOW-PAY-008). Click stays off unless it is listed in
 * PAYMENT_PROVIDERS and has a secret; nothing here turns it on. But once it IS
 * on, it must have its real ids: starting with placeholders would hand buyers
 * links to another merchant's service.
 */
export function collectClickConfigErrors(
  env: Record<string, unknown>,
): string[] {
  const get = (key: string) =>
    typeof env[key] === 'string' ? env[key] : undefined;
  if (!isClickEnabled(get)) return [];
  const errors: string[] = [];
  for (const key of ['CLICK_SERVICE_ID', 'CLICK_MERCHANT_ID']) {
    if (!clickId(get(key))) {
      errors.push(
        `${key} must be the numeric id Click issued (placeholders such as 12345 / 67890 are refused) when Click is enabled.`,
      );
    }
  }
  return errors;
}

/** ConfigModule `validate` step. */
export function validateClickEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const errors = collectClickConfigErrors(env);
  if (errors.length > 0) {
    throw new Error(`Invalid Click configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return env;
}
