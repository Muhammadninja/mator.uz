// Mator's service fee: the approved tariff, and how it enters what an order charges.

import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import {
  SERVICE_FEE_TIERS,
  calculateServiceFeeUzs,
  computeOrderCharges,
  linesSubtotalUzs,
  toTiyin,
} from './service-fee.util';

describe('calculateServiceFeeUzs — the approved tariff', () => {
  it.each([
    [50_000, 0],
    [100_000, 0],
    [100_001, 5_000],
    [150_000, 5_000],
    [199_999, 5_000],
    [200_000, 10_000],
    [499_999, 10_000],
    [500_000, 20_000],
    [999_999, 20_000],
    [1_000_000, 30_000],
    [2_000_000, 30_000],
  ])('%p UZS of parts → %p UZS', (parts, fee) => {
    expect(calculateServiceFeeUzs(parts)).toBe(fee);
  });

  it('charges nothing for nothing', () => {
    expect(calculateServiceFeeUzs(0)).toBe(0);
  });

  // The cost is never rounded to a som first: between 100 000 and 100 001, or just under
  // 200 000, it is still what it is.
  it.each([
    [100_000.01, 5_000],
    [100_000.5, 5_000],
    [199_999.99, 5_000],
    [499_999.99, 10_000],
    [999_999.99, 20_000],
    [1_000_000.01, 30_000],
  ])('%p UZS of parts → %p UZS, to the tiyin', (parts, fee) => {
    expect(calculateServiceFeeUzs(parts)).toBe(fee);
  });

  it('is a flat amount by tier, never a share of the cost', () => {
    expect(calculateServiceFeeUzs(500_000)).toBe(
      calculateServiceFeeUzs(999_999),
    );
    expect(calculateServiceFeeUzs(5_000_000)).toBe(30_000);
  });

  it.each([NaN, -1, -0.01, Infinity])(
    'refuses %p rather than charge for it',
    (bad) => {
      expect(() => calculateServiceFeeUzs(bad)).toThrow(RangeError);
    },
  );

  it('is a whole number of som on every tier, so a receipt line is whole too', () => {
    for (const tier of SERVICE_FEE_TIERS) {
      expect(Number.isInteger(tier.feeUzs)).toBe(true);
    }
  });

  it('starts at zero and only ever rises', () => {
    expect(SERVICE_FEE_TIERS[0]).toEqual({ fromTiyin: 0, feeUzs: 0 });
    for (let i = 1; i < SERVICE_FEE_TIERS.length; i += 1) {
      expect(SERVICE_FEE_TIERS[i].fromTiyin).toBeGreaterThan(
        SERVICE_FEE_TIERS[i - 1].fromTiyin,
      );
      expect(SERVICE_FEE_TIERS[i].feeUzs).toBeGreaterThan(
        SERVICE_FEE_TIERS[i - 1].feeUzs,
      );
    }
  });
});

describe('computeOrderCharges', () => {
  const part = (unitPriceUzs: number, quantity = 1, partId = 'p') => ({
    partId,
    unitPriceUzs,
    quantity,
  });

  it('the brief’s example: 600 000 of parts, delivery 25 000, total 645 000', () => {
    expect(
      computeOrderCharges({
        lines: [part(600_000)],
        discountUzs: 0,
        deliveryUzs: 25_000,
      }),
    ).toEqual({
      subtotalUzs: 600_000,
      discountUzs: 0,
      serviceFeeUzs: 20_000,
      deliveryUzs: 25_000,
      totalUzs: 645_000,
    });
  });

  it('without delivery the total is the parts and the fee', () => {
    expect(
      computeOrderCharges({
        lines: [part(600_000)],
        discountUzs: 0,
        deliveryUzs: 0,
      }).totalUzs,
    ).toBe(620_000);
  });

  it('several lines and quantities: one fee for the whole order, never one per line', () => {
    const charges = computeOrderCharges({
      lines: [
        part(150_000, 1, 'a'),
        part(100_000, 2, 'b'),
        part(50_000, 3, 'c'),
      ],
      discountUzs: 0,
      deliveryUzs: 0,
    });
    // 150 000 + 200 000 + 150 000 = 500 000: the 20 000 tier, once.
    expect(charges.subtotalUzs).toBe(500_000);
    expect(charges.serviceFeeUzs).toBe(20_000);
  });

  it('does not depend on how many sellers or lines the parts come in', () => {
    const one = computeOrderCharges({
      lines: [part(300_000, 1, 'a')],
      discountUzs: 0,
      deliveryUzs: 0,
    });
    const five = computeOrderCharges({
      lines: ['a', 'b', 'c', 'd', 'e'].map((id) => part(60_000, 1, id)),
      discountUzs: 0,
      deliveryUzs: 0,
    });
    expect(five.serviceFeeUzs).toBe(one.serviceFeeUzs);
    expect(five.totalUzs).toBe(one.totalUzs);
  });

  it('counts sourced offers as parts, and services booked beside them not at all', () => {
    const charges = computeOrderCharges({
      lines: [
        { offerId: 'o1', unitPriceUzs: 150_000, quantity: 1 },
        { serviceId: 's1', unitPriceUzs: 400_000, quantity: 1 },
      ],
      discountUzs: 0,
      deliveryUzs: 0,
    });
    expect(charges.subtotalUzs).toBe(550_000);
    expect(charges.serviceFeeUzs).toBe(5_000);
    expect(charges.totalUzs).toBe(555_000);
  });

  it('a cart of services alone carries no fee', () => {
    expect(
      computeOrderCharges({
        lines: [{ serviceId: 's1', unitPriceUzs: 300_000, quantity: 1 }],
        discountUzs: 0,
        deliveryUzs: 0,
      }).serviceFeeUzs,
    ).toBe(0);
  });

  it('a promo discounts the goods, never the fee or delivery; the tier reads the parts before it', () => {
    const charges = computeOrderCharges({
      lines: [part(200_000)],
      discountUzs: 20_000,
      deliveryUzs: 25_000,
    });
    expect(charges.serviceFeeUzs).toBe(10_000);
    expect(charges.totalUzs).toBe(200_000 - 20_000 + 10_000 + 25_000);
  });

  it('the fee does not move delivery, and delivery does not move the fee', () => {
    const base = { lines: [part(150_000)], discountUzs: 0 };
    expect(computeOrderCharges({ ...base, deliveryUzs: 0 }).serviceFeeUzs).toBe(
      computeOrderCharges({ ...base, deliveryUzs: 90_000 }).serviceFeeUzs,
    );
    expect(
      computeOrderCharges({ ...base, deliveryUzs: 90_000 }).deliveryUzs,
    ).toBe(90_000);
  });

  it('a change to the cart changes the fee: it is worked out again from the lines', () => {
    const at = (quantity: number) =>
      computeOrderCharges({
        lines: [part(99_000, quantity)],
        discountUzs: 0,
        deliveryUzs: 0,
      });
    expect(at(1).serviceFeeUzs).toBe(0);
    expect(at(2).serviceFeeUzs).toBe(5_000);
    expect(at(6).serviceFeeUzs).toBe(20_000);
    expect(at(11).serviceFeeUzs).toBe(30_000);
  });

  it('fractional prices add up exactly: no float noise can cross a tier', () => {
    // As floats, 0.1 + 0.2 is not 0.3, and three lines like these can come to a hair
    // above 100 000. In tiyin they come to exactly 100 000, which is the 0 tier.
    const lines = [
      part(33_333.33, 1, 'a'),
      part(33_333.33, 1, 'b'),
      part(33_333.34, 1, 'c'),
    ];
    const charges = computeOrderCharges({
      lines,
      discountUzs: 0,
      deliveryUzs: 0,
    });
    expect(charges.subtotalUzs).toBe(100_000);
    expect(charges.serviceFeeUzs).toBe(0);

    expect(linesSubtotalUzs([part(21_505.57, 3)])).toBe(64_516.71);
  });

  it('the total is subtotal − discount + fee + delivery, to the tiyin, for any order', () => {
    for (const [price, quantity, discount, delivery] of [
      [21_505.57, 3, 0, 15_000],
      [33_333, 3, 10_000, 0],
      [1_250_000.5, 1, 125_000, 37_500],
    ]) {
      const c = computeOrderCharges({
        lines: [part(price, quantity)],
        discountUzs: discount,
        deliveryUzs: delivery,
      });
      expect(toTiyin(c.totalUzs)).toBe(
        toTiyin(c.subtotalUzs) -
          toTiyin(c.discountUzs) +
          toTiyin(c.serviceFeeUzs) +
          toTiyin(c.deliveryUzs),
      );
    }
  });
});

describe('the service fee in the code', () => {
  const backend = join(__dirname, '..', '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : [join(dir, entry.name)],
    );
  const filesMatching = (pattern: RegExp, dirs: string[]) =>
    dirs
      .flatMap((dir) => walk(join(backend, dir)))
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => !/\.spec\.ts$|test-util\.ts$/.test(file))
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(backend, file))
      .sort();

  it('has one table of tiers, and nothing else holds a tier', () => {
    expect(filesMatching(/SERVICE_FEE_TIERS/, ['src', 'scripts'])).toEqual([
      'src/orders/service-fee.util.ts',
    ]);
  });

  it('is written once, when the order is created: a new reader or writer has to be looked at', () => {
    expect(filesMatching(/\bserviceFeeUzs\b/, ['src', 'scripts'])).toEqual([
      'src/admin/finance/admin-finance-checks.service.ts', // shows an order's charges
      'src/admin/finance/admin-finance.service.ts', // sums what Mator kept
      'src/admin/orders/admin-orders.presenter.ts', // shows it
      'src/admin/orders/admin-orders.service.ts', // sums Mator's income
      'src/admin/refunds/admin-refunds.presenter.ts', // a refund's share of it
      'src/admin/refunds/admin-refunds.service.ts', // a refund's share of it
      'src/admin/refunds/dto/record-refund.dto.ts', // a refund's share of it
      'src/cart/cart.presenter.ts', // shows what an order placed now would charge
      'src/orders/financial-refund.ledger.ts', // what of it went back
      'src/orders/order-settlement.ts', // keeps it out of what a seller is owed
      'src/orders/order.presenter.ts', // shows it
      'src/orders/orders.service.ts', // the one writer, at creation
      'src/orders/refund-breakdown.ts', // what of it can still go back
      'src/orders/service-fee.util.ts', // works it out
      'src/orders/webhooks/payme-fiscal.service.ts', // its receipt line
    ]);
  });
});
