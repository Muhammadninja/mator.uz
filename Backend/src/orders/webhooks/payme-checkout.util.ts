import { DEFAULT_PAYME_CHECKOUT_URL } from './payme.config';

export interface PaymeCheckoutParams {
  merchantId: string;
  accountField: string;
  orderId: string;
  amountTiyin: number;
  checkoutBaseUrl?: string;
  /** Where Payme returns the user after payment (`c` parameter). */
  returnUrl?: string;
}

/**
 * Build the official Payme checkout link.
 *
 * Format (Payme "Отправка чека по методу GET"): the checkout host followed by
 * base64 of a semicolon-separated parameter list —
 *
 *   m={merchant_id};ac.{account_field}={order_id};a={amount_in_tiyin}
 *
 * e.g. `m=587f72c7…;ac.order_id=197;a=500` → `https://checkout.paycom.uz/bT01ODdm…`
 *
 * `a` is in tiyin (1 UZS = 100 tiyin) and must equal the amount the webhook
 * later validates, so callers pass the same integer used for `amountTiyin` on
 * the payment row. `ac.` prefixes the account field configured for the merchant
 * — this must match the field Payme sends back in `params.account`, or
 * CheckPerformTransaction cannot resolve the order.
 */
export function buildPaymeCheckoutUrl(params: PaymeCheckoutParams): string {
  const {
    merchantId,
    accountField,
    orderId,
    amountTiyin,
    checkoutBaseUrl = DEFAULT_PAYME_CHECKOUT_URL,
    returnUrl,
  } = params;

  const parts = [
    `m=${merchantId}`,
    `ac.${accountField}=${orderId}`,
    `a=${amountTiyin}`,
  ];
  // `c` is the return URL Payme sends the user back to; omitted when unset so
  // the encoded payload stays exactly the three required parameters.
  if (returnUrl) parts.push(`c=${returnUrl}`);

  const encoded = Buffer.from(parts.join(';'), 'utf8').toString('base64');
  return `${checkoutBaseUrl.replace(/\/+$/, '')}/${encoded}`;
}
