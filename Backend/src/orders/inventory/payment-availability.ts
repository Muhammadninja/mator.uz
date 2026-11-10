import { InventoryReservationStatus as Status } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { findUnavailableParts, UnavailableLine } from '../order-availability';
import { ACTIVE_PROVIDER_STATE } from '../order-status.service';
import { inventoryReservationsEnabled } from './inventory-availability';
import { deductedUnits } from './inventory-reservation.store';

type Db = Pick<
  PrismaService,
  | 'catalogPart'
  | 'partCategory'
  | 'orderItem'
  | 'inventoryReservation'
  | 'payment'
> &
  Partial<
    Pick<PrismaService, 'sourcingOffer' | 'seller' | 'providerServiceOffering'>
  >;

type OpenRow = {
  id: string;
  orderId: string | null;
  partId: string | null;
  status: Status;
  createdAt: Date;
  expiresAt: Date | null;
  quantity: number;
  reconciledQty: number;
  restockedQty: number;
};

/** Who has the stronger claim on a unit: a sale before a hold, then the earlier one. */
function claimOrder(a: OpenRow, b: OpenRow): number {
  const rank = (r: OpenRow) => (r.status === Status.ALLOCATED ? 0 : 1);
  return (
    rank(a) - rank(b) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Can this existing order still be paid for? The payment gate for the invoice and for
 * Payme's CheckPerformTransaction.
 *
 * An order is never refused because of its own units, and is always held against other
 * buyers' units:
 *   • a part it holds counts only the OTHER reservations that come before its own: sales
 *     first, then holds by age. Reservations made after it were made against what it
 *     left, so they never take its units; if a smaller 1C count no longer covers them
 *     all, the earliest claims are served first;
 *   • a part it holds no reservation for (placed before reservations, or while they were
 *     off) is held against every reservation, like a new buyer;
 *   • a hold whose payment window has passed, with no provider transaction keeping it
 *     open, is no claim at all: the order cannot be paid, whatever the stock says.
 *
 * With reservations off this is exactly the check it replaces.
 */
export async function findUnavailableForPayment(
  prisma: Db,
  orderId: string,
  now: Date = new Date(),
): Promise<UnavailableLine[]> {
  const items = await prisma.orderItem.findMany({
    where: { orderId },
    // Every line type: an offer or a service is re-checked at payment too.
    select: {
      partId: true,
      title: true,
      quantity: true,
      offerId: true,
      serviceId: true,
      providerId: true,
    },
  });
  if (!inventoryReservationsEnabled())
    return findUnavailableParts(prisma, items);

  const partIds = [
    ...new Set(items.map((i) => i.partId).filter((id): id is string => !!id)),
  ];
  if (partIds.length === 0) return findUnavailableParts(prisma, items);

  const [open, activeTx] = await Promise.all([
    prisma.inventoryReservation.findMany({
      where: {
        partId: { in: partIds },
        status: { in: [Status.HELD, Status.ALLOCATED] },
      },
      select: {
        id: true,
        orderId: true,
        partId: true,
        status: true,
        createdAt: true,
        expiresAt: true,
        quantity: true,
        reconciledQty: true,
        restockedQty: true,
      },
    }),
    prisma.payment.findFirst({
      where: { orderId, providerState: ACTIVE_PROVIDER_STATE },
      select: { id: true },
    }),
  ]);

  const reservedAhead = new Map<string, number>();
  const lapsedParts = new Set<string>();
  for (const partId of partIds) {
    const rows = open.filter((r) => r.partId === partId).sort(claimOrder);
    const own = rows.filter((r) => r.orderId === orderId);
    if (own.length === 0) continue;
    const lapsed = own.some(
      (r) =>
        r.status === Status.HELD &&
        r.expiresAt !== null &&
        r.expiresAt <= now &&
        !activeTx,
    );
    if (lapsed) {
      lapsedParts.add(partId);
      continue;
    }
    const first = rows.indexOf(own[0]);
    reservedAhead.set(
      partId,
      rows
        .slice(0, first)
        .filter((r) => r.orderId !== orderId)
        .reduce((sum, r) => sum + deductedUnits(r), 0),
    );
  }
  return findUnavailableParts(prisma, items, { reservedAhead, lapsedParts });
}
