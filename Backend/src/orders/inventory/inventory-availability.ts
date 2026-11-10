import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { DRIVERS_VILLAGE_CATALOG_SELLER_ID } from '../../imports/drivers-village/drivers-village.constants';

/**
 * Off until the migration has been deployed and verified. Read on every use rather than
 * injected, so that the pure availability helpers and the status chokepoint need no new
 * dependency.
 */
export function inventoryReservationsEnabled(): boolean {
  return process.env.INVENTORY_RESERVATIONS_ENABLED === 'true';
}

interface CountedPart {
  stockQty: number;
  reservedQty?: number | null;
}

/** Units Mator has promised. Zero while the feature is off, whatever the column holds. */
export function reservedUnits(part: Pick<CountedPart, 'reservedQty'>): number {
  return inventoryReservationsEnabled() ? (part.reservedQty ?? 0) : 0;
}

/**
 * A count exists when stockQty is positive. Zero with `inStock` true is a Telegram
 * listing, which nothing ever counted and which never takes a reservation.
 */
export function isCounted(part: Pick<CountedPart, 'stockQty'>): boolean {
  return part.stockQty > 0;
}

/**
 * availableQty = reportedStockQty - activeReservations - unreconciledSales, never below
 * zero. Both subtractions are carried by reservedQty.
 */
export function availableUnits(part: CountedPart): number {
  return Math.max(0, part.stockQty - reservedUnits(part));
}

/**
 * Out of stock, whatever else the row says. A Driver's Village count is always real: its
 * zero is zero, even on a row whose `inStock` disagrees, so it can never be read as a
 * Telegram listing nobody counted. Applies with reservations on or off.
 */
export function isOutOfStock(part: {
  inStock: boolean;
  stockQty: number;
  sellerId?: string | null;
}): boolean {
  return (
    !part.inStock ||
    (part.sellerId === DRIVERS_VILLAGE_CATALOG_SELLER_ID && part.stockQty <= 0)
  );
}

/** A counted part whose every unit is promised, though the supplier still reports some. */
export function exhaustedByReservations(part: CountedPart): boolean {
  return isCounted(part) && availableUnits(part) === 0;
}

/** The buyer-facing `in_stock` of a part. */
export function isBuyerInStock(
  part: CountedPart & { inStock: boolean },
): boolean {
  return part.inStock && !exhaustedByReservations(part);
}

/**
 * The SQL twin of {@link exhaustedByReservations}, to AND into a read that lists only
 * what can be bought. Empty while the feature is off.
 */
export function sellableWhere(
  prisma: Pick<PrismaService, 'catalogPart'>,
): Prisma.CatalogPartWhereInput {
  if (!inventoryReservationsEnabled()) return {};
  return {
    OR: [
      { stockQty: { lte: 0 } },
      { stockQty: { gt: prisma.catalogPart.fields.reservedQty } },
    ],
  };
}
