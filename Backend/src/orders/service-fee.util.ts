/**
 * Mator's service fee and what an order charges: the ONE place both are worked out. The
 * cart the buyer looks at and the order they place call the same function, so the app, the
 * order, the payment and the receipt cannot disagree. The app holds no copy of these tiers:
 * it shows what the API answers. To change the tariff, change the table below.
 *
 * The fee belongs to Mator alone. It is charged once per order, however many lines or
 * sellers the order has, and it is never part of a goods price, of delivery, or of what a
 * seller is paid (see order-settlement.util.ts).
 *
 * Everything is worked in whole TIYIN, the unit Decimal(14,2) stores and Payme is paid in,
 * because a catalog price can have a fractional part. Summing such prices as floats can land
 * on 100000.00000000001, which would charge a fee on an order of exactly 100 000.
 */

/** Sum to tiyin. Only removes binary noise: a stored amount has no finer part than this. */
export function toTiyin(uzs: number): number {
  return Math.round(uzs * 100);
}

export interface ServiceFeeTier {
  /** The parts cost this tier starts at, inclusive, in tiyin (`100_000_01` = 100 000.01). */
  fromTiyin: number;
  feeUzs: number;
}

/**
 * The approved tariff ("tariff A", confirmed by the business on 2026-11-06), ascending. The
 * first boundary is the odd one out because the tariff says "up to and including 100 000"
 * there, and "from" everywhere else.
 */
export const SERVICE_FEE_TIERS: readonly ServiceFeeTier[] = [
  { fromTiyin: 0, feeUzs: 0 }, // up to and including 100 000
  { fromTiyin: 100_000_01, feeUzs: 5_000 }, // above 100 000, below 200 000
  { fromTiyin: 200_000_00, feeUzs: 10_000 }, // from 200 000, below 500 000
  { fromTiyin: 500_000_00, feeUzs: 20_000 }, // from 500 000, below 1 000 000
  { fromTiyin: 1_000_000_00, feeUzs: 30_000 }, // from 1 000 000
];

/**
 * The fee for a cost of parts, in whole UZS. A flat amount by tier, never a percentage. The
 * cost is compared as it stands, to the tiyin, and not rounded to a som first: 199 999.99 is
 * below 200 000.
 *
 * @throws RangeError on a cost that is not a sum of money: a bug upstream must not turn into
 * a charge, or into a free order.
 */
export function calculateServiceFeeUzs(partsCostUzs: number): number {
  if (!Number.isFinite(partsCostUzs) || partsCostUzs < 0) {
    throw new RangeError(`Not a cost of parts: ${partsCostUzs}`);
  }
  const tiyin = toTiyin(partsCostUzs);
  let feeUzs = 0;
  for (const tier of SERVICE_FEE_TIERS) {
    if (tiyin >= tier.fromTiyin) feeUzs = tier.feeUzs;
  }
  return feeUzs;
}

/** A cart or order line, as far as the money cares. */
export interface PricedLine {
  partId?: string | null;
  offerId?: string | null;
  serviceId?: string | null;
  /** What one unit is charged: the sale price where a sale applies. */
  unitPriceUzs: number;
  quantity: number;
}

/** A service booked alongside the goods is not a part. A line naming nothing is goods. */
function isPartsLine(line: PricedLine): boolean {
  return !!line.partId || !!line.offerId || !line.serviceId;
}

const sumTiyin = (lines: readonly PricedLine[]): number =>
  lines.reduce(
    (sum, line) => sum + toTiyin(line.unitPriceUzs) * line.quantity,
    0,
  );

/** What these lines come to, with no float noise in the result. */
export function linesSubtotalUzs(lines: readonly PricedLine[]): number {
  return sumTiyin(lines) / 100;
}

/** Each part of what an order charges, in UZS. Stored and handled separately. */
export interface OrderCharges {
  /** Every line at its current price, before a promo code. */
  subtotalUzs: number;
  /** The promo discount. Spread into the line prices when an order is created. */
  discountUzs: number;
  serviceFeeUzs: number;
  deliveryUzs: number;
  /** `subtotal - discount + service fee + delivery`. */
  totalUzs: number;
}

/**
 * What these lines charge. The tier is read from the parts as priced before a promo code,
 * which is the figure the buyer sees as the cost of the parts. A promo code discounts the
 * goods and leaves the fee and delivery alone.
 */
export function computeOrderCharges(input: {
  lines: readonly PricedLine[];
  discountUzs: number;
  deliveryUzs: number;
}): OrderCharges {
  const subtotalTiyin = sumTiyin(input.lines);
  const serviceFeeUzs = calculateServiceFeeUzs(
    sumTiyin(input.lines.filter(isPartsLine)) / 100,
  );
  const goodsTiyin = Math.max(0, subtotalTiyin - toTiyin(input.discountUzs));
  return {
    subtotalUzs: subtotalTiyin / 100,
    discountUzs: input.discountUzs,
    serviceFeeUzs,
    deliveryUzs: input.deliveryUzs,
    totalUzs:
      (goodsTiyin + toTiyin(serviceFeeUzs) + toTiyin(input.deliveryUzs)) / 100,
  };
}
