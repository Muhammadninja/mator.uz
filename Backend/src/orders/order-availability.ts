import { ConflictException } from '@nestjs/common';
import { DealerStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
 * Deliberately NOT a quantity check: `stockQty` is a real count only for
 * dealer-synced / admin-managed positions — Telegram listings keep the default
 * 0 while being in stock — and there is no reservation or decrement model, so
 * a quantity rule would either block the Telegram catalogue or promise more
 * than it can keep. Reservation is a separate, schema-level change.
 */
export type UnavailableReason =
  'missing' | 'out_of_stock' | 'dealer_suspended' | 'no_price';

export interface UnavailableLine {
  partId: string;
  title: string;
  reason: UnavailableReason;
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
  prisma: Pick<PrismaService, 'catalogPart'>,
  lines: readonly { partId: string | null; title: string }[],
): Promise<UnavailableLine[]> {
  const partLines = lines.filter(
    (l): l is { partId: string; title: string } => !!l.partId,
  );
  if (partLines.length === 0) return [];

  const parts = await prisma.catalogPart.findMany({
    where: { id: { in: [...new Set(partLines.map((l) => l.partId))] } },
    select: {
      id: true,
      inStock: true,
      priceUzs: true,
      seller: { select: { status: true } },
    },
  });
  const byId = new Map(parts.map((p) => [p.id, p]));

  const unavailable: UnavailableLine[] = [];
  for (const line of partLines) {
    const part = byId.get(line.partId);
    const reason: UnavailableReason | null = !part
      ? 'missing'
      : part.seller.status === DealerStatus.SUSPENDED
        ? 'dealer_suspended'
        : !part.inStock
          ? 'out_of_stock'
          : Number(part.priceUzs) <= 0
            ? 'no_price'
            : null;
    if (reason) unavailable.push({ ...line, reason });
  }
  return unavailable;
}

/** 409 { code: PART_UNAVAILABLE } naming the lines, when any is unavailable. */
export function assertAllAvailable(
  unavailable: readonly UnavailableLine[],
): void {
  if (unavailable.length === 0) return;
  throw new ConflictException({
    code: PART_UNAVAILABLE,
    message: `No longer available: ${unavailable
      .map((u) => `${u.title} (${u.reason})`)
      .join('; ')}`,
  });
}
