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
