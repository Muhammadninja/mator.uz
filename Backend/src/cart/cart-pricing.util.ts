import { Prisma } from '@prisma/client';
import { DiscountResult, DiscountService } from '../sales/discount.service';

/**
 * The minimum a cart/order line exposes to be sale-priced: its id (the map key),
 * the part it points at (null for service lines), and the snapshot unit price.
 * Structural so both a Prisma `CartItem` and any hand-built test line fit.
 */
export interface PriceableLine {
  id: string;
  partId: string | null;
  priceUzsSnapshot: Prisma.Decimal | number;
}

/**
 * Price a set of cart/order lines against the currently-active sales, returning
 * a Map keyed by LINE id (so a service line with no part, or a part that was
 * since deleted, simply has no entry). One `loadActiveSales` + one part lookup
 * for the whole set, regardless of line count.
 *
 * The sale is applied to each line's SNAPSHOT price, which refreshCartLinePrices
 * has just brought up to date, so the discount tracks the campaign live (a sale
 * that starts or ends changes the cart on the next read). Scope matching needs
 * the part's category/seller, which the line doesn't carry, so the parts are
 * fetched here.
 */
export async function priceCartLines(
  prisma: Pick<Prisma.TransactionClient, 'catalogPart' | 'sale'>,
  discounts: DiscountService,
  lines: PriceableLine[],
): Promise<Map<string, DiscountResult>> {
  const partIds = [
    ...new Set(lines.map((l) => l.partId).filter((x): x is string => !!x)),
  ];
  if (partIds.length === 0) return new Map();

  const [sales, parts] = await Promise.all([
    discounts.loadActiveSales(undefined, prisma),
    prisma.catalogPart.findMany({
      where: { id: { in: partIds } },
      select: { id: true, categoryId: true, sellerId: true },
    }),
  ]);

  const scopeById = new Map(parts.map((p) => [p.id, p]));
  const out = new Map<string, DiscountResult>();
  for (const line of lines) {
    if (!line.partId) continue;
    const scope = scopeById.get(line.partId);
    if (!scope) continue;
    out.set(
      line.id,
      discounts.calculateDiscount(
        Number(line.priceUzsSnapshot),
        { id: scope.id, categoryId: scope.categoryId, sellerId: scope.sellerId },
        sales,
      ),
    );
  }
  return out;
}

/** What a cart line needs for its current price to be looked up. */
export interface RepriceableLine extends PriceableLine {
  serviceId: string | null;
  offerId: string | null;
}

type PriceSourceDb = Pick<
  Prisma.TransactionClient,
  'catalogPart' | 'providerServiceOffering' | 'sourcingOffer'
>;

/**
 * The price each line's own source states now, keyed by line id. Parts, services
 * and sourcing offers each hold theirs; the cart's snapshot is only ever a copy.
 * null means the source no longer exists, so the line has no current price.
 */
export async function currentLinePrices(
  db: PriceSourceDb,
  lines: readonly RepriceableLine[],
): Promise<Map<string, number | null>> {
  const idsOf = (pick: (l: RepriceableLine) => string | null) => [
    ...new Set(lines.map(pick).filter((x): x is string => !!x)),
  ];
  const partIds = idsOf((l) => l.partId);
  const serviceIds = idsOf((l) => l.serviceId);
  const offerIds = idsOf((l) => l.offerId);

  const parts = partIds.length
    ? await db.catalogPart.findMany({
        where: { id: { in: partIds } },
        select: { id: true, priceUzs: true },
      })
    : [];
  const services = serviceIds.length
    ? await db.providerServiceOffering.findMany({
        where: { id: { in: serviceIds } },
        select: { id: true, priceUzs: true },
      })
    : [];
  const offers = offerIds.length
    ? await db.sourcingOffer.findMany({
        where: { id: { in: offerIds } },
        select: { id: true, price: true },
      })
    : [];
  const partPrice = new Map(parts.map((p) => [p.id, Number(p.priceUzs)]));
  const servicePrice = new Map(services.map((p) => [p.id, Number(p.priceUzs)]));
  const offerPrice = new Map(offers.map((o) => [o.id, o.price]));

  return new Map(
    lines.map((l) => {
      const price = l.partId
        ? partPrice.get(l.partId)
        : l.serviceId
          ? servicePrice.get(l.serviceId)
          : l.offerId
            ? offerPrice.get(l.offerId)
            : undefined;
      return [l.id, price ?? null];
    }),
  );
}

const sameMoney = (a: number, b: number): boolean =>
  Math.round(a * 100) === Math.round(b * 100);

export interface RefreshedCartLines<T> {
  /** The same lines, each carrying its current price as its snapshot. */
  items: T[];
  /** A line's price differed from the snapshot the cart held. */
  changed: boolean;
  /** Lines whose price source is gone; their snapshot is left as it was. */
  withoutSource: T[];
}

/**
 * Bring a cart's price snapshots up to date with their sources, and store the
 * ones that moved. Takes the plain client on purpose, never an order's
 * transaction: a caller about to refuse the order with a 409 needs this to
 * survive that refusal, so that the buyer's cart shows the new price.
 */
export async function refreshCartLinePrices<T extends RepriceableLine>(
  prisma: PriceSourceDb & Pick<Prisma.TransactionClient, 'cartItem'>,
  lines: readonly T[],
): Promise<RefreshedCartLines<T>> {
  const prices = await currentLinePrices(prisma, lines);
  const withoutSource: T[] = [];
  let changed = false;
  const items: T[] = [];
  for (const line of lines) {
    const current = prices.get(line.id) ?? null;
    if (current === null) {
      withoutSource.push(line);
      items.push(line);
      continue;
    }
    if (sameMoney(current, Number(line.priceUzsSnapshot))) {
      items.push(line);
      continue;
    }
    changed = true;
    // updateMany: a line removed meanwhile is nothing to fail over.
    await prisma.cartItem.updateMany({
      where: { id: line.id },
      data: { priceUzsSnapshot: current },
    });
    items.push({ ...line, priceUzsSnapshot: new Prisma.Decimal(current) });
  }
  return { items, changed, withoutSource };
}

/**
 * The unit price each line would be charged now: its current source price with
 * the sales live now. For a check inside an order's transaction, so `db` is that
 * transaction and nothing is written. A line whose source is gone is absent.
 */
export async function chargedUnitPrices(
  db: PriceSourceDb & Pick<Prisma.TransactionClient, 'sale'>,
  discounts: DiscountService,
  lines: readonly RepriceableLine[],
): Promise<Map<string, number>> {
  const prices = await currentLinePrices(db, lines);
  const repriced = lines.flatMap((line) => {
    const current = prices.get(line.id);
    return current == null ? [] : [{ ...line, priceUzsSnapshot: current }];
  });
  const sales = await priceCartLines(db, discounts, repriced);
  return new Map(
    repriced.map((line) => {
      const sale = sales.get(line.id);
      return [
        line.id,
        sale?.appliedSale ? sale.finalPrice : Number(line.priceUzsSnapshot),
      ];
    }),
  );
}
