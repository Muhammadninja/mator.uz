import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ActiveSale, DiscountService } from '../../sales/discount.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Sorting and price ranges by the price the buyer SEES (LOW-CAT-007).
 *
 * The card shows the sale price (DiscountService.calculateDiscount). Sorting
 * by the stored `price_uzs` put a 300 000 сум part on sale for 150 000 after a
 * 200 000 one in "cheapest first". So:
 *
 *   • with no sale running, the stored price IS the visible price, and the
 *     database sorts and aggregates as before (no extra work at all);
 *   • with sales running, the matching rows' prices are read once (four narrow
 *     columns), each priced exactly as its card will be, sorted by that price
 *     with the id as tiebreak (stable pages), and the page's ids are returned.
 *
 * The discount is applied in one place, the same call the card uses, so it can
 * never be applied twice. MATOR10 is a cart promo code and is not involved.
 *
 * Above MAX_PRICED_ROWS matching rows the stored price is used instead and a
 * warning logged: the catalog is far below that today.
 */
export const MAX_PRICED_ROWS = 20_000;

const logger = new Logger('EffectivePrice');

type PricedRow = { id: string; price: number };

export interface EffectivePriceScan {
  /** Ordered ids of the requested page. */
  pageIds: string[];
  min: number;
  max: number;
  /** Visible price of every matching row, for buckets and ranges. */
  prices: number[];
}

export function isPriceSort(
  sort: string | undefined,
): sort is 'price_asc' | 'price_desc' {
  return sort === 'price_asc' || sort === 'price_desc';
}

/**
 * Price every row of `where` as its card does and return one page in that
 * order. Null when the scan does not apply (no sale running, or too many rows);
 * the caller then uses the database order, which is then the same thing.
 */
export async function scanByEffectivePrice(
  prisma: Pick<PrismaService, 'catalogPart'>,
  discounts: Pick<DiscountService, 'calculateDiscount'>,
  sales: ActiveSale[],
  where: Prisma.CatalogPartWhereInput,
  opts: { sort?: 'price_asc' | 'price_desc'; skip: number; take: number },
): Promise<EffectivePriceScan | null> {
  if (sales.length === 0) return null;
  const rows = await prisma.catalogPart.findMany({
    where,
    select: { id: true, priceUzs: true, categoryId: true, sellerId: true },
    take: MAX_PRICED_ROWS + 1,
  });
  if (rows.length > MAX_PRICED_ROWS) {
    logger.warn(
      `More than ${MAX_PRICED_ROWS} parts match; sorting by stored price for this request`,
    );
    return null;
  }
  const priced: PricedRow[] = rows.map((r) => ({
    id: r.id,
    price: discounts.calculateDiscount(
      Number(r.priceUzs),
      { id: r.id, categoryId: r.categoryId, sellerId: r.sellerId },
      sales,
    ).finalPrice,
  }));
  const dir = opts.sort === 'price_desc' ? -1 : 1;
  priced.sort(
    (a, b) =>
      dir * (a.price - b.price) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const prices = priced.map((p) => p.price);
  return {
    pageIds: priced.slice(opts.skip, opts.skip + opts.take).map((p) => p.id),
    min: prices.length ? Math.min(...prices) : 0,
    max: prices.length ? Math.max(...prices) : 0,
    prices,
  };
}

/** Rows fetched by id, returned in the order of `ids`. */
export function inIdOrder<T extends { id: string }>(
  ids: string[],
  rows: T[],
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is T => r !== undefined);
}
