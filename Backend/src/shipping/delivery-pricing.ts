import { createHash } from 'crypto';

/**
 * What courier delivery costs for a road distance. The one place the rule lives, and pure
 * on purpose: it knows nothing about routing providers, orders or where the rates came
 * from, so anything that needs a price can reuse it.
 *
 * The distance is rounded UP to whole kilometres, then read off a table by kilometre.
 * Past the end of the table each further kilometre adds a fixed amount.
 */
export interface DeliveryRates {
  /** Price by billable kilometre, in whole UZS: index 0 is 1 km, index 1 is 2 km, ... */
  tierPricesUzs: readonly number[];
  /** Added per billable kilometre beyond the table. */
  extraKmPriceUzs: number;
}

export const DEFAULT_DELIVERY_RATES: DeliveryRates = {
  tierPricesUzs: [
    5_000, 7_000, 9_000, 12_000, 15_000, 18_000, 21_000, 24_000, 27_000, 30_000,
  ],
  extraKmPriceUzs: 2_500,
};

/**
 * Names a set of rates. Derived from the rates themselves, so a change of rates is always a
 * new version and nobody has to remember to bump one. A quote is bound to this, and an order
 * records which rates it was charged under.
 */
export function tariffVersionOf(rates: DeliveryRates): string {
  return createHash('sha256')
    .update(JSON.stringify([rates.tierPricesUzs, rates.extraKmPriceUzs]))
    .digest('hex')
    .slice(0, 16);
}

export interface RoutePrice {
  billableKm: number;
  priceUzs: number;
}

/**
 * @throws RangeError for a distance that is not finite and positive. No price exists for
 * one, and callers must not be able to turn it into the cheapest tier.
 */
export function priceRoute(
  distanceMeters: number,
  rates: DeliveryRates = DEFAULT_DELIVERY_RATES,
): RoutePrice {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    throw new RangeError(`Not a route distance: ${distanceMeters}`);
  }
  const billableKm = Math.ceil(distanceMeters / 1000);
  const tiers = rates.tierPricesUzs;
  const priceUzs =
    billableKm <= tiers.length
      ? tiers[billableKm - 1]
      : tiers[tiers.length - 1] +
        (billableKm - tiers.length) * rates.extraKmPriceUzs;
  return { billableKm, priceUzs };
}
