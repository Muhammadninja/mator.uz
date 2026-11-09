import { ConflictException } from '@nestjs/common';
import { DealerStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loadCategoryTreeScope } from '../catalog/categories/category-tree-scope';

/**
 * Can these catalog parts still be sold? The availability gate shared by cart
 * add, order creation, Payme invoice creation and Payme CheckPerformTransaction.
 *
 * What "available" means is limited to what the data reliably says:
 *   • the part still exists;
 *   • `CatalogPart.inStock` is true — the availability flag every writer keeps
 *     (catalog projection, dealer 1C sync, admin inventory);
 *   • its dealer storefront is not SUSPENDED (see catalog/buyer-visibility.ts);
 *   • it has a price. There is no free-of-charge sale in the business, so a price
 *     of 0 is a data error rather than an offer, whatever wrote it.
 *
 * Quantity. The 1C import, a dealer sync and admin inventory are the sources of a real
 * count, and each writes `stockQty` and `inStock = quantity > 0` together, so a real zero
 * is always `inStock` false and is refused above as out of stock, available 0. Telegram
 * listings are the only rows with 0 and `inStock` true: nothing ever counted them, so
 * their quantity is not limited. Any other value of `stockQty` is the amount on hand.
 *
 * There is no reservation or decrement model, so this refuses more than is on hand but
 * cannot stop two buyers each ordering the last unit. Reservation is a separate,
 * schema-level change.
 */
export type UnavailableReason =
  | 'missing'
  | 'out_of_stock'
  | 'dealer_suspended'
  | 'no_price'
  | 'insufficient_stock'
  | 'category_hidden';

export interface UnavailableLine {
  partId: string;
  title: string;
  reason: UnavailableReason;
  /** With `insufficient_stock`: what is on hand, and what was asked for. */
  availableQuantity?: number;
  requestedQuantity?: number;
}

/** Does this count refuse `requested`? Only ever reached with `inStock` true, see above. */
export function exceedsCountedStock(stockQty: number, requested: number): boolean {
  return stockQty > 0 && requested > stockQty;
}

/** The 409 for asking more of a counted position than is on hand. */
export function insufficientStockError(
  partId: string,
  title: string,
  available: number,
  requested: number,
): ConflictException {
  return new ConflictException({
    code: PART_UNAVAILABLE,
    message: `Only ${available} available: ${title}`,
    details: {
      lines: [
        { part_id: partId, available_quantity: available, requested_quantity: requested },
      ],
    },
  });
}

/** Machine-readable error code the client can switch on. */
export const PART_UNAVAILABLE = 'PART_UNAVAILABLE';

/** The order needs courier delivery, and no real cost for it is known. */
export const DELIVERY_COST_UNAVAILABLE = 'DELIVERY_COST_UNAVAILABLE';

/** The courier price computed now is not the one the buyer confirmed. */
export const DELIVERY_PRICE_CHANGED = 'DELIVERY_PRICE_CHANGED';

/** The destination, a pickup point or the rates are not those the quote was for. */
export const DELIVERY_QUOTE_STALE = 'DELIVERY_QUOTE_STALE';

/** The cart was changed or already ordered while this order was being placed. */
export const CART_CHANGED = 'CART_CHANGED';

/** The total computed now is not the one the buyer confirmed. */
export const ORDER_TOTAL_CHANGED = 'ORDER_TOTAL_CHANGED';

export async function findUnavailableParts(
  prisma: Pick<PrismaService, 'catalogPart' | 'partCategory'>,
  lines: readonly { partId: string | null; title: string; quantity?: number }[],
): Promise<UnavailableLine[]> {
  const partLines = lines.filter(
    (l): l is { partId: string; title: string; quantity?: number } => !!l.partId,
  );
  if (partLines.length === 0) return [];

  const parts = await prisma.catalogPart.findMany({
    where: { id: { in: [...new Set(partLines.map((l) => l.partId))] } },
    select: {
      id: true,
      inStock: true,
      stockQty: true,
      priceUzs: true,
      categoryId: true,
      seller: { select: { status: true } },
    },
  });
  const tree = await loadCategoryTreeScope(prisma);
  const byId = new Map(parts.map((p) => [p.id, p]));

  // One position on two lines still draws on one count.
  const requestedByPart = new Map<string, number>();
  for (const line of partLines) {
    requestedByPart.set(
      line.partId,
      (requestedByPart.get(line.partId) ?? 0) + (line.quantity ?? 0),
    );
  }

  const unavailable: UnavailableLine[] = [];
  for (const line of partLines) {
    const part = byId.get(line.partId);
    const reason: UnavailableReason | null = !part
      ? 'missing'
      : part.seller.status === DealerStatus.SUSPENDED
        ? 'dealer_suspended'
        : tree.isHidden(part.categoryId)
          ? 'category_hidden'
        : !part.inStock
          ? 'out_of_stock'
          : Number(part.priceUzs) <= 0
            ? 'no_price'
            : exceedsCountedStock(part.stockQty, requestedByPart.get(line.partId) ?? 0)
              ? 'insufficient_stock'
              : null;
    if (reason === 'insufficient_stock' || reason === 'out_of_stock') {
      unavailable.push({
        partId: line.partId,
        title: line.title,
        reason,
        availableQuantity: reason === 'out_of_stock' ? 0 : part!.stockQty,
        requestedQuantity: requestedByPart.get(line.partId),
      });
    } else if (reason) {
      unavailable.push({ partId: line.partId, title: line.title, reason });
    }
  }
  return unavailable;
}

/** 409 { code: PART_UNAVAILABLE } naming the lines, when any is unavailable. */
export function assertAllAvailable(
  unavailable: readonly UnavailableLine[],
): void {
  if (unavailable.length === 0) return;
  const short = unavailable.filter(
    (u) => u.reason === 'insufficient_stock' || u.reason === 'out_of_stock',
  );
  throw new ConflictException({
    code: PART_UNAVAILABLE,
    message: `No longer available: ${unavailable
      .map((u) =>
        u.reason === 'insufficient_stock'
          ? `${u.title} (only ${u.availableQuantity} available)`
          : `${u.title} (${u.reason})`,
      )
      .join('; ')}`,
    ...(short.length > 0
      ? {
          details: {
            lines: short.map((u) => ({
              part_id: u.partId,
              available_quantity: u.availableQuantity ?? 0,
              requested_quantity: u.requestedQuantity,
            })),
          },
        }
      : {}),
  });
}
