import { Prisma } from '@prisma/client';

/**
 * What an order's money is made of, and what a refund gives back of each part. Pure, so the
 * rules are testable apart from the registry that applies them.
 *
 * An order takes its total in four kinds of money, which belong to different people:
 *   • each seller's goods (their lines, as charged, so net of a promo);
 *   • goods no seller is recorded for (orders placed before sellers were frozen on lines);
 *   • delivery, Mator's line;
 *   • the service fee, Mator's income.
 * They add up to the total. A refund is split across them, so what each seller is owed, and
 * what Mator keeps, stays true after money goes back.
 *
 * Mator's commission rides on each seller's goods, at the rate frozen on the order's lines. When
 * goods go back, the commission on them goes with them, in proportion, so a seller is never
 * charged commission on a sale that was returned, and Mator does not keep it.
 */

type Decimal = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);
const dec = (value: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(value ?? 0);
const sum = (values: Prisma.Decimal.Value[]) =>
  values.reduce<Decimal>((total, value) => total.add(value), ZERO);
const atMost = (value: Decimal, cap: Decimal) => (value.gt(cap) ? cap : value);
const atLeastZero = (value: Decimal) => (value.lt(0) ? ZERO : value);

/** One kind of money on an order: what it took, what went back, and what could still go. */
export interface ComponentPosition {
  charged: Decimal;
  refunded: Decimal;
  remaining: Decimal;
}

/** A seller's goods on an order, and Mator's commission on them, as they stand. */
export type SellerPosition = { sellerId: string } & ComponentPosition & {
    /** Charged on the goods, reversed with refunds of them, and what is left of it. */
    commission: ComponentPosition;
  };

export interface OrderComponents {
  serviceFee: ComponentPosition;
  delivery: ComponentPosition;
  sellers: SellerPosition[];
  unattributed: ComponentPosition;
}

/** One seller's share of a refund: the goods, and the commission that goes with them. */
export interface RefundAllocation {
  sellerId: string;
  amountUzs: Decimal;
  commissionUzs: Decimal;
}

/** What a refund gives back, part by part. The parts add up to the refund's amount. */
export interface RefundBreakdown {
  serviceFeeUzs: Decimal;
  deliveryUzs: Decimal;
  allocations: RefundAllocation[];
  /** Goods no seller can be named for. Never stated: what is left once the rest is. */
  unattributedUzs: Decimal;
}

/**
 * An order, as far as its kinds of money go. Its goods are what the total holds besides the
 * fee and delivery, so an order whose lines do not account for them (one placed by hand, or
 * before sellers were recorded) still has goods that can go back: those nobody is named for.
 */
export interface ComponentOrder {
  totalUzs: Prisma.Decimal.Value;
  serviceFeeUzs: Prisma.Decimal.Value;
  deliveryUzs: Prisma.Decimal.Value;
  items: {
    sellerId: string | null;
    lineTotalUzs: Prisma.Decimal.Value;
    /** Frozen on the line when the order was placed. Absent on an older row: none. */
    commissionUzs?: Prisma.Decimal.Value;
  }[];
}

/** A registry entry, as far as its kinds of money go. */
export interface ComponentEntry {
  amountUzs: Prisma.Decimal.Value;
  serviceFeeUzs: Prisma.Decimal.Value;
  deliveryUzs: Prisma.Decimal.Value;
  allocations: {
    sellerId: string;
    amountUzs: Prisma.Decimal.Value;
    commissionUzs?: Prisma.Decimal.Value;
  }[];
}

function position(charged: Decimal, refunded: Decimal): ComponentPosition {
  const capped = atMost(atLeastZero(refunded), charged);
  return { charged, refunded: capped, remaining: charged.sub(capped) };
}

/**
 * Where each kind of money stands. `tookMoney` false means the order took nothing, so there is
 * nothing of any kind. `everythingBack` true means all of it went back, whatever the entries
 * say, which covers a provider reversal that has no entry of its own.
 */
export function readComponents(input: {
  order: ComponentOrder | null;
  entries: readonly ComponentEntry[];
  tookMoney: boolean;
  everythingBack: boolean;
}): OrderComponents {
  const { order, entries, tookMoney, everythingBack } = input;
  const items = tookMoney && order ? order.items : [];

  const add = (map: Map<string, Decimal>, key: string, value: Decimal) =>
    map.set(key, (map.get(key) ?? ZERO).add(value));

  const sellerCharged = new Map<string, Decimal>();
  const commissionCharged = new Map<string, Decimal>();
  for (const item of items) {
    if (!item.sellerId) continue;
    add(sellerCharged, item.sellerId, dec(item.lineTotalUzs));
    add(commissionCharged, item.sellerId, dec(item.commissionUzs));
  }
  const goodsCharged =
    tookMoney && order
      ? atLeastZero(
          dec(order.totalUzs)
            .sub(dec(order.serviceFeeUzs))
            .sub(dec(order.deliveryUzs)),
        )
      : ZERO;
  const unattributedCharged = atLeastZero(
    goodsCharged.sub(sum([...sellerCharged.values()])),
  );

  const sellerRefunded = new Map<string, Decimal>();
  const commissionReversed = new Map<string, Decimal>();
  let unattributedRefunded = ZERO;
  for (const entry of entries) {
    const allocated = sum(entry.allocations.map((a) => a.amountUzs));
    for (const allocation of entry.allocations) {
      add(sellerRefunded, allocation.sellerId, dec(allocation.amountUzs));
      add(
        commissionReversed,
        allocation.sellerId,
        dec(allocation.commissionUzs),
      );
    }
    unattributedRefunded = unattributedRefunded.add(
      dec(entry.amountUzs)
        .sub(dec(entry.serviceFeeUzs))
        .sub(dec(entry.deliveryUzs))
        .sub(allocated),
    );
  }

  const of = (charged: Decimal, refunded: Decimal) =>
    position(charged, everythingBack ? charged : refunded);
  return {
    serviceFee: of(
      tookMoney && order ? dec(order.serviceFeeUzs) : ZERO,
      sum(entries.map((e) => e.serviceFeeUzs)),
    ),
    delivery: of(
      tookMoney && order ? dec(order.deliveryUzs) : ZERO,
      sum(entries.map((e) => e.deliveryUzs)),
    ),
    sellers: [...sellerCharged].map(([sellerId, charged]) => ({
      sellerId,
      ...of(charged, sellerRefunded.get(sellerId) ?? ZERO),
      commission: of(
        commissionCharged.get(sellerId) ?? ZERO,
        commissionReversed.get(sellerId) ?? ZERO,
      ),
    })),
    unattributed: of(unattributedCharged, unattributedRefunded),
  };
}

/** Everything that could still go back, of every kind. */
export function remainingOf(components: OrderComponents): Decimal {
  return sum([
    components.serviceFee.remaining,
    components.delivery.remaining,
    components.unattributed.remaining,
    ...components.sellers.map((s) => s.remaining),
  ]);
}

/**
 * The breakdown of an amount nobody stated one for: a provider reversal, or a refund of all
 * that is left. Goods first, seller by seller, then delivery, then the fee, so a reversal of
 * everything takes everything. What no kind can take is an over-payment going back, and stays
 * with the goods nobody is named for.
 */
export function deriveBreakdown(
  components: OrderComponents,
  amount: Decimal,
): RefundBreakdown {
  let left = amount;
  const take = (remaining: Decimal) => {
    const taken = atMost(left, remaining);
    left = left.sub(taken);
    return taken;
  };
  const allocations = withCommission(
    components,
    components.sellers
      .map((seller) => ({
        sellerId: seller.sellerId,
        amountUzs: take(seller.remaining),
      }))
      .filter((allocation) => allocation.amountUzs.gt(0)),
  );
  const unattributed = take(components.unattributed.remaining);
  const deliveryUzs = take(components.delivery.remaining);
  const serviceFeeUzs = take(components.serviceFee.remaining);
  return {
    serviceFeeUzs,
    deliveryUzs,
    allocations,
    unattributedUzs: unattributed.add(left),
  };
}

/** What an operator stated about a refund. Anything left out is not taken to be zero blindly. */
export interface StatedBreakdown {
  serviceFeeUzs?: Prisma.Decimal.Value;
  deliveryUzs?: Prisma.Decimal.Value;
  allocations?: { sellerId: string; amountUzs: Prisma.Decimal.Value }[];
}

export type BreakdownCheck =
  | { ok: true; breakdown: RefundBreakdown }
  | { ok: false; code: string; message: string };

const refuse = (code: string, message: string): BreakdownCheck => ({
  ok: false,
  code,
  message,
});

/**
 * The breakdown of a refund an operator records, or why it cannot be taken. A refund of all
 * that is left is everything, so it needs no breakdown, and one stated for it has to agree.
 * A partial refund leaves the fee and delivery where they are unless it says otherwise, and
 * says whose goods it was for wherever that is not plain: no part can go back twice, and no
 * seller's goods can go back for another seller's.
 */
export function checkStatedBreakdown(
  components: OrderComponents,
  amount: Decimal,
  stated: StatedBreakdown,
): BreakdownCheck {
  const fee = dec(stated.serviceFeeUzs);
  const delivery = dec(stated.deliveryUzs);
  if (fee.lt(0) || delivery.lt(0)) {
    return refuse(
      'REFUND_BREAKDOWN_INVALID',
      'No part of a refund can be negative.',
    );
  }

  if (amount.eq(remainingOf(components))) {
    const whole = deriveBreakdown(components, amount);
    const agrees =
      (stated.serviceFeeUzs === undefined || fee.eq(whole.serviceFeeUzs)) &&
      (stated.deliveryUzs === undefined || delivery.eq(whole.deliveryUzs)) &&
      (stated.allocations === undefined ||
        sameAllocations(stated.allocations, whole.allocations));
    return agrees
      ? { ok: true, breakdown: whole }
      : refuse(
          'REFUND_BREAKDOWN_MISMATCH',
          'This refund is all that is left of the order, so it is all of every part. The breakdown stated does not say that.',
        );
  }

  if (fee.gt(amount) || fee.gt(components.serviceFee.remaining)) {
    return refuse(
      'REFUND_FEE_EXCEEDS_CHARGED',
      `The service fee part cannot be more than the refund, or than the ${components.serviceFee.remaining.toFixed(2)} UZS of the fee this order still holds.`,
    );
  }
  if (
    delivery.gt(amount.sub(fee)) ||
    delivery.gt(components.delivery.remaining)
  ) {
    return refuse(
      'REFUND_DELIVERY_EXCEEDS_CHARGED',
      `The delivery part cannot be more than the rest of the refund, or than the ${components.delivery.remaining.toFixed(2)} UZS of delivery this order still holds.`,
    );
  }

  const goods = amount.sub(fee).sub(delivery);
  const goodsLeft = sum([
    components.unattributed.remaining,
    ...components.sellers.map((s) => s.remaining),
  ]);
  if (goods.gt(goodsLeft)) {
    return refuse(
      'REFUND_BREAKDOWN_REQUIRED',
      `Only ${goodsLeft.toFixed(2)} UZS of goods can still go back. State how much of this refund is the service fee and delivery.`,
    );
  }

  const amounts = stated.allocations
    ? checkAllocations(components, stated.allocations)
    : plainAllocations(components, goods);
  if (!Array.isArray(amounts)) return amounts;
  const allocations = withCommission(components, amounts);
  const allocated = sum(allocations.map((a) => a.amountUzs));
  const unattributed = goods.sub(allocated);
  if (
    unattributed.lt(0) ||
    unattributed.gt(components.unattributed.remaining)
  ) {
    return refuse(
      'REFUND_ALLOCATION_MISMATCH',
      'The goods part of this refund and what it says each seller gets back do not add up.',
    );
  }
  return {
    ok: true,
    breakdown: {
      serviceFeeUzs: fee,
      deliveryUzs: delivery,
      allocations,
      unattributedUzs: unattributed,
    },
  };
}

type AllocatedAmount = { sellerId: string; amountUzs: Decimal };

/**
 * The commission that goes back with each seller's goods: in proportion to the commission
 * charged on them, to the tiyin, and all of what is left of it when all of what is left of the
 * goods goes back, so rounding can never leave a seller charged on a fully returned sale.
 */
function withCommission(
  components: OrderComponents,
  allocations: AllocatedAmount[],
): RefundAllocation[] {
  return allocations.map((allocation) => {
    const seller = components.sellers.find(
      (s) => s.sellerId === allocation.sellerId,
    );
    if (!seller || seller.charged.lte(0)) {
      return { ...allocation, commissionUzs: ZERO };
    }
    const share = allocation.amountUzs.eq(seller.remaining)
      ? seller.commission.remaining
      : allocation.amountUzs
          .mul(seller.commission.charged)
          .div(seller.charged)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    return {
      ...allocation,
      commissionUzs: atMost(share, seller.commission.remaining),
    };
  });
}

/** Allocations an operator stated: known sellers, each once, each within what it has left. */
function checkAllocations(
  components: OrderComponents,
  stated: NonNullable<StatedBreakdown['allocations']>,
): AllocatedAmount[] | BreakdownCheck {
  const seen = new Set<string>();
  const out: AllocatedAmount[] = [];
  for (const { sellerId, amountUzs } of stated) {
    const seller = components.sellers.find((s) => s.sellerId === sellerId);
    const amount = dec(amountUzs);
    if (
      !seller ||
      seen.has(sellerId) ||
      amount.lte(0) ||
      amount.gt(seller.remaining)
    ) {
      return refuse(
        'REFUND_ALLOCATION_INVALID',
        `Seller ${sellerId} has no goods on this order that could go back for that much.`,
      );
    }
    seen.add(sellerId);
    out.push({ sellerId, amountUzs: amount });
  }
  return out;
}

/**
 * Whose goods a partial refund was for, where only one answer is possible: the order's goods
 * all belong to one seller, or to nobody named. With more than one, someone has to say.
 */
function plainAllocations(
  components: OrderComponents,
  goods: Decimal,
): AllocatedAmount[] | BreakdownCheck {
  if (goods.eq(0)) return [];
  const withGoods = components.sellers.filter((s) => s.remaining.gt(0));
  if (withGoods.length === 0) return [];
  if (withGoods.length === 1 && components.unattributed.remaining.eq(0)) {
    return [{ sellerId: withGoods[0].sellerId, amountUzs: goods }];
  }
  return refuse(
    'REFUND_ALLOCATION_REQUIRED',
    'This order has goods from more than one seller. State whose goods this refund is for.',
  );
}

function sameAllocations(
  stated: NonNullable<StatedBreakdown['allocations']>,
  derived: RefundBreakdown['allocations'],
): boolean {
  if (stated.length !== derived.length) return false;
  return derived.every((d) =>
    stated.some(
      (s) => s.sellerId === d.sellerId && dec(s.amountUzs).eq(d.amountUzs),
    ),
  );
}
