import { buildPaymeCheckoutUrl } from './payme-checkout.util';

/**
 * The checkout link is the one artefact the customer actually opens, and Payme
 * accepts exactly one shape: base64 of `m=…;ac.<field>=…;a=<tiyin>` appended to
 * the checkout host. These assertions pin that byte-for-byte.
 */
describe('buildPaymeCheckoutUrl', () => {
  const base = {
    merchantId: '587f72c72cac0d162c722ae2',
    accountField: 'order_id',
    orderId: '197',
    amountTiyin: 500,
  };

  it('reproduces the example from the Payme documentation', () => {
    // Documented pair: m=587f72c72cac0d162c722ae2;ac.order_id=197;a=500
    expect(buildPaymeCheckoutUrl(base)).toBe(
      'https://checkout.paycom.uz/bT01ODdmNzJjNzJjYWMwZDE2MmM3MjJhZTI7YWMub3JkZXJfaWQ9MTk3O2E9NTAw',
    );
  });

  it('encodes merchant id, account field and tiyin amount in order', () => {
    const url = buildPaymeCheckoutUrl({
      ...base,
      orderId: 'ord_01HXC3KR',
      amountTiyin: 21_500_000,
    });
    const decoded = Buffer.from(
      url.split('/').pop() as string,
      'base64',
    ).toString('utf8');
    expect(decoded).toBe(
      'm=587f72c72cac0d162c722ae2;ac.order_id=ord_01HXC3KR;a=21500000',
    );
  });

  it('honours a custom account field', () => {
    const url = buildPaymeCheckoutUrl({ ...base, accountField: 'invoice' });
    const decoded = Buffer.from(
      url.split('/').pop() as string,
      'base64',
    ).toString('utf8');
    expect(decoded).toContain('ac.invoice=197');
  });

  it('appends the return url as `c` only when provided', () => {
    const withReturn = buildPaymeCheckoutUrl({
      ...base,
      returnUrl: 'https://mator.uz/done',
    });
    const decoded = Buffer.from(
      withReturn.split('/').pop() as string,
      'base64',
    ).toString('utf8');
    expect(decoded).toBe(
      'm=587f72c72cac0d162c722ae2;ac.order_id=197;a=500;c=https://mator.uz/done',
    );

    const withoutReturn = Buffer.from(
      buildPaymeCheckoutUrl(base).split('/').pop() as string,
      'base64',
    ).toString('utf8');
    expect(withoutReturn).not.toContain(';c=');
  });

  it('targets the sandbox host when one is configured', () => {
    const url = buildPaymeCheckoutUrl({
      ...base,
      checkoutBaseUrl: 'https://test.paycom.uz',
    });
    expect(url.startsWith('https://test.paycom.uz/')).toBe(true);
  });

  it('does not double the separator when the base url has a trailing slash', () => {
    const url = buildPaymeCheckoutUrl({
      ...base,
      checkoutBaseUrl: 'https://checkout.paycom.uz/',
    });
    expect(url).not.toContain('uz//');
  });
});
