import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
 * The sale is applied to each line's SNAPSHOT price — the price captured when the
 * item was added — so the discount tracks the campaign live (a sale that starts
 * or ends changes the cart on the next read) without disturbing the snapshot the
 * cart already holds. Scope matching needs the part's category/seller, which the
 * line doesn't carry, so the parts are fetched here.
 */
export async function priceCartLines(
  prisma: PrismaService,
  discounts: DiscountService,
  lines: PriceableLine[],
): Promise<Map<string, DiscountResult>> {
  const partIds = [
    ...new Set(lines.map((l) => l.partId).filter((x): x is string => !!x)),
  ];
  if (partIds.length === 0) return new Map();

  const [sales, parts] = await Promise.all([
    discounts.loadActiveSales(),
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
