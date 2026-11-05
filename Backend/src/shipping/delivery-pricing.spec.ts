// The courier price rule, exactly as the business states it.

import {
  DEFAULT_DELIVERY_RATES,
  DeliveryRates,
  priceRoute,
} from './delivery-pricing';

describe('priceRoute', () => {
  it.each([
    // Every example the pricing rules give.
    [500, 1, 5_000],
    [1_000, 1, 5_000],
    [1_100, 2, 7_000],
    [2_500, 3, 9_000],
    [3_200, 4, 12_000],
    [5_000, 5, 15_000],
    [7_300, 8, 24_000],
    [10_000, 10, 30_000],
    [10_100, 11, 32_500],
    [15_000, 15, 42_500],
    [20_000, 20, 55_000],
  ])('%i m is billed as %i km at %i UZS', (meters, billableKm, priceUzs) => {
    expect(priceRoute(meters)).toEqual({ billableKm, priceUzs });
  });

  it.each([
    [1, 5_000],
    [2, 7_000],
    [3, 9_000],
    [4, 12_000],
    [5, 15_000],
    [6, 18_000],
    [7, 21_000],
    [8, 24_000],
    [9, 27_000],
    [10, 30_000],
  ])('exactly %i km costs %i UZS', (km, priceUzs) => {
    expect(priceRoute(km * 1000)).toEqual({ billableKm: km, priceUzs });
  });

  it('rounds up from the very first metre past a kilometre', () => {
    expect(priceRoute(1).billableKm).toBe(1);
    expect(priceRoute(1_000).billableKm).toBe(1);
    expect(priceRoute(1_001).billableKm).toBe(2);
    expect(priceRoute(10_000.5)).toEqual({ billableKm: 11, priceUzs: 32_500 });
  });

  it('keeps adding 2,500 per kilometre past the table', () => {
    expect(priceRoute(100_000).priceUzs).toBe(30_000 + 90 * 2_500);
  });

  it.each([0, -1, -5000, NaN, Infinity, -Infinity])(
    'has no price for a distance of %p',
    (meters) => {
      expect(() => priceRoute(meters)).toThrow(RangeError);
    },
  );

  it('follows the rates it is given, with the defaults only as defaults', () => {
    const rates: DeliveryRates = {
      tierPricesUzs: [1_000, 2_000],
      extraKmPriceUzs: 500,
    };
    expect(priceRoute(1_500, rates)).toEqual({
      billableKm: 2,
      priceUzs: 2_000,
    });
    expect(priceRoute(3_500, rates)).toEqual({
      billableKm: 4,
      priceUzs: 3_000,
    });
    expect(DEFAULT_DELIVERY_RATES.tierPricesUzs).toHaveLength(10);
  });
});
