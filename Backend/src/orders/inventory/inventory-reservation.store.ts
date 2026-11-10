import {
  InventoryReconciliationSource,
  InventoryReservation,
  InventoryReservationStatus as Status,
  OrderStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { IdPrefix, prefixedId } from '../../common/ulid.util';
import { OFFLINE_PAYMENT_TYPES } from '../offline-order.policy';
import {
  inventoryReservationsEnabled,
  isCounted,
} from './inventory-availability';

type Tx = Prisma.TransactionClient;

/** The lock order is cart or order, then parts by id, then reservation rows. */
export async function lockParts(
  tx: Tx,
  partIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(partIds)];
  if (ids.length === 0) return;
  // NO KEY: serialises every count of these parts, without blocking the foreign-key
  // checks of rows that merely point at them.
  await tx.$queryRaw`SELECT id FROM catalog_parts WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR NO KEY UPDATE`;
}

/** Raw, so that `updated_at` keeps meaning a supplier or operator changed the part. */
async function adjustReserved(
  tx: Tx,
  partId: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  await tx.$executeRaw`UPDATE catalog_parts SET reserved_qty = GREATEST(reserved_qty + ${delta}, 0) WHERE id = ${partId}`;
}

export function deductedUnits(
  row: Pick<
    InventoryReservation,
    'quantity' | 'reconciledQty' | 'restockedQty'
  >,
): number {
  return row.quantity - row.reconciledQty - row.restockedQty;
}

const STOCK_PART_ID = /^part_stock_(\d+)$/;

interface OrderForReservation {
  id: string;
  expiresAt: Date | null;
  paymentType: PaymentType | null;
  items: readonly {
    id: string;
    partId: string | null;
    title: string;
    quantity: number;
  }[];
}

/**
 * Write the order's reservations. Call inside the order's transaction, under
 * {@link lockParts}, after the availability gate has passed: a rollback takes these
 * with it. A part with no count gets none.
 */
export async function reserveOrderLines(
  tx: Tx,
  order: OrderForReservation,
): Promise<void> {
  const lines = order.items.filter(
    (i): i is typeof i & { partId: string } => !!i.partId && i.quantity > 0,
  );
  if (lines.length === 0) return;
  const parts = await tx.catalogPart.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.partId))] } },
    select: {
      id: true,
      stockQty: true,
      sellerId: true,
      oemNumbers: true,
      gmNumbers: true,
      seller: { select: { name: true } },
    },
  });
  const counted = new Map(parts.filter(isCounted).map((p) => [p.id, p]));
  const reservable = lines.filter((l) => counted.has(l.partId));
  if (reservable.length === 0) return;

  const stockIdOf = (partId: string) => {
    const match = STOCK_PART_ID.exec(partId);
    return match ? Number(match[1]) : null;
  };
  const candidates = reservable
    .map((l) => stockIdOf(l.partId))
    .filter((id): id is number => id !== null);
  const known = new Set(
    candidates.length
      ? (
          await tx.stock.findMany({
            where: { id: { in: candidates } },
            select: { id: true },
          })
        ).map((s) => s.id)
      : [],
  );
  const offline =
    !!order.paymentType && OFFLINE_PAYMENT_TYPES.includes(order.paymentType);

  await tx.inventoryReservation.createMany({
    data: reservable.map((line) => {
      const part = counted.get(line.partId)!;
      const stockId = stockIdOf(line.partId);
      return {
        id: prefixedId(IdPrefix.INVENTORY_RESERVATION),
        orderId: order.id,
        orderItemId: line.id,
        partId: line.partId,
        stockId: stockId !== null && known.has(stockId) ? stockId : null,
        orderRef: order.id,
        orderItemRef: line.id,
        partRef: line.partId,
        sellerId: part.sellerId,
        sellerName: part.seller.name,
        title: line.title,
        partNumbers: [
          ...new Set([...part.gmNumbers, ...part.oemNumbers]),
        ].slice(0, 10),
        quantity: line.quantity,
        expiresAt: offline ? null : order.expiresAt,
      };
    }),
  });

  const perPart = new Map<string, number>();
  for (const line of reservable) {
    perPart.set(line.partId, (perPart.get(line.partId) ?? 0) + line.quantity);
  }
  for (const partId of [...perPart.keys()].sort()) {
    await adjustReserved(tx, partId, perPart.get(partId)!);
  }
}

/** The order's payment window moved: an unperformed provider payment was cancelled. */
export async function extendHold(
  tx: Tx,
  orderId: string,
  expiresAt: Date,
): Promise<void> {
  if (!inventoryReservationsEnabled()) return;
  await tx.inventoryReservation.updateMany({
    where: { orderId, status: Status.HELD, expiresAt: { not: null } },
    data: { expiresAt },
  });
}

/** What a reservation becomes once nothing of it is deducted any more. */
function settledStatus(
  row: Pick<InventoryReservation, 'reconciledQty'>,
): Status {
  return row.reconciledQty > 0 ? Status.RECONCILED : Status.RELEASED;
}

/**
 * Follow an order's status, in the transaction that moved it. Every status write goes
 * through OrderStatusService, so nothing else has to remember this. Guarded on each
 * row's own status, so a repeated callback changes nothing.
 */
export async function applyOrderStatus(
  tx: Tx,
  orderId: string,
  status: OrderStatus,
): Promise<void> {
  if (!inventoryReservationsEnabled()) return;
  const now = new Date();
  switch (status) {
    case OrderStatus.PAID:
      await tx.inventoryReservation.updateMany({
        where: { orderId, status: Status.HELD },
        data: {
          status: Status.ALLOCATED,
          allocatedAt: now,
          statusChangedAt: now,
        },
      });
      return;
    case OrderStatus.SHIPPED:
    case OrderStatus.DELIVERED:
      await tx.inventoryReservation.updateMany({
        where: { orderId, status: Status.HELD },
        data: {
          status: Status.ALLOCATED,
          allocatedAt: now,
          fulfilledAt: now,
          statusChangedAt: now,
        },
      });
      await tx.inventoryReservation.updateMany({
        where: { orderId, status: Status.ALLOCATED, fulfilledAt: null },
        data: { fulfilledAt: now },
      });
      return;
    case OrderStatus.CANCELLED:
    case OrderStatus.EXPIRED:
    case OrderStatus.REFUNDED:
      await finishOrder(tx, orderId, status, now);
      return;
    default:
      return;
  }
}

/**
 * The order ended. Goods that never left and were never paid for in person go back on
 * sale. Goods that left, or that an operator took money for, stay deducted until an
 * operator says they came back: an ended order does not put a part on the shelf.
 */
async function finishOrder(
  tx: Tx,
  orderId: string,
  status: OrderStatus,
  now: Date,
) {
  const open = await tx.inventoryReservation.findMany({
    where: { orderId, status: { in: [Status.HELD, Status.ALLOCATED] } },
    select: { partId: true },
  });
  if (open.length === 0) return;
  await lockParts(
    tx,
    open.map((r) => r.partId).filter((id): id is string => !!id),
  );
  const collected = await tx.offlineCollection.findUnique({
    where: { orderId },
    select: { id: true },
  });
  const rows = await tx.inventoryReservation.findMany({
    where: { orderId, status: { in: [Status.HELD, Status.ALLOCATED] } },
    orderBy: { partRef: 'asc' },
  });
  for (const row of rows) {
    if (row.fulfilledAt || collected) {
      await tx.inventoryReservation.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: Status.ALLOCATED,
          allocatedAt: row.allocatedAt ?? now,
          returnPendingAt: now,
          statusChangedAt:
            row.status === Status.HELD ? now : row.statusChangedAt,
        },
      });
      continue;
    }
    await releaseRow(tx, row, `Order ${status.toLowerCase()}`, now);
  }
}

/** Give back what a row still deducts. Conditional, so it counts at most once. */
export async function releaseRow(
  tx: Tx,
  row: InventoryReservation,
  reason: string,
  now: Date = new Date(),
): Promise<boolean> {
  const moved = await tx.inventoryReservation.updateMany({
    where: { id: row.id, status: row.status },
    data: {
      status: settledStatus(row),
      releasedAt: now,
      releaseReason: reason.slice(0, 500),
      statusChangedAt: now,
      returnPendingAt: null,
    },
  });
  if (moved.count !== 1) return false;
  if (row.partId) await adjustReserved(tx, row.partId, -deductedUnits(row));
  return true;
}

/** An operator marked these units as back with the supplier. Caller holds the part lock. */
export async function restockRow(
  tx: Tx,
  row: InventoryReservation,
  units: number,
  now: Date = new Date(),
): Promise<boolean> {
  const left = deductedUnits(row) - units;
  const moved = await tx.inventoryReservation.updateMany({
    where: {
      id: row.id,
      status: Status.ALLOCATED,
      restockedQty: row.restockedQty,
    },
    data: {
      restockedQty: row.restockedQty + units,
      ...(left === 0
        ? {
            status: settledStatus(row),
            releasedAt: now,
            releaseReason: 'Restocked',
            statusChangedAt: now,
            returnPendingAt: null,
          }
        : {}),
    },
  });
  if (moved.count !== 1) return false;
  if (row.partId) await adjustReserved(tx, row.partId, -units);
  return true;
}

/** An operator confirmed the source includes this sale. Caller holds the part lock. */
export async function reconcileRow(
  tx: Tx,
  row: InventoryReservation,
  ref: string,
  now: Date = new Date(),
): Promise<boolean> {
  return settleUnits(
    tx,
    row,
    deductedUnits(row),
    InventoryReconciliationSource.OPERATOR,
    ref,
    now,
  );
}

async function settleUnits(
  tx: Tx,
  row: InventoryReservation,
  units: number,
  source: InventoryReconciliationSource,
  ref: string,
  now: Date,
): Promise<boolean> {
  const whole = units === deductedUnits(row);
  const moved = await tx.inventoryReservation.updateMany({
    where: {
      id: row.id,
      status: Status.ALLOCATED,
      reconciledQty: row.reconciledQty,
    },
    data: {
      reconciledQty: row.reconciledQty + units,
      reconciliationSource: source,
      reconciliationRef: ref.slice(0, 500),
      reconciliationNote: whole
        ? null
        : `The source showed ${units} of the ${deductedUnits(row)} units still open`,
      ...(whole
        ? {
            status: Status.RECONCILED,
            reconciledAt: now,
            statusChangedAt: now,
            returnPendingAt: null,
          }
        : {}),
    },
  });
  if (moved.count !== 1) return false;
  if (row.partId) await adjustReserved(tx, row.partId, -units);
  return true;
}

/** The file a supplier quantity came from. */
export interface SourceFile {
  /** When the supplier sent it: a file cannot include a sale made after this. */
  at: Date;
  ref: string;
}

export interface ReconcileOutcome {
  reconciled: number;
  unresolved: number;
}

/**
 * Credit a new supplier count against sales Mator already deducted, oldest first.
 *
 * The evidence is the fall in the count, spent once: a sale is settled by no more units
 * than the count dropped since the last file. Availability is therefore never raised by
 * this (reported falls by `drop`, deductions by at most `drop`), and a re-import, whose
 * count is unchanged, has nothing to spend. A rise says nothing, since it may be stock
 * arriving on top of a recorded sale. A file older than the sale cannot show it, and a
 * file of unknown date proves nothing. In those cases the deduction stands and the row
 * says why. HELD units are not touched.
 *
 * Call under {@link lockParts}, in the transaction that writes the new count.
 */
export async function reconcileFromSource(
  tx: Tx,
  partId: string,
  previousQty: number,
  newQty: number,
  source: SourceFile | null,
  now: Date = new Date(),
): Promise<ReconcileOutcome> {
  const outcome: ReconcileOutcome = { reconciled: 0, unresolved: 0 };
  if (previousQty === newQty) return outcome;
  const rows = await tx.inventoryReservation.findMany({
    where: { partId, status: Status.ALLOCATED },
    orderBy: [{ allocatedAt: 'asc' }, { id: 'asc' }],
  });
  let credit = Math.max(0, previousQty - newQty);
  const noteFor = (row: InventoryReservation): string => {
    if (!source)
      return `A file of unknown date moved the count ${previousQty} → ${newQty}`;
    if (!row.allocatedAt || row.allocatedAt >= source.at) {
      return `${source.ref} was sent before this sale`;
    }
    return credit === 0 && previousQty < newQty
      ? `${source.ref} raised the count ${previousQty} → ${newQty}: stock may have arrived on top of this sale`
      : `${source.ref} did not lower the count enough to cover this sale`;
  };

  for (const row of rows) {
    const eligible =
      !!source && !!row.allocatedAt && row.allocatedAt < source.at;
    const units = eligible ? Math.min(credit, deductedUnits(row)) : 0;
    if (units > 0 && source) {
      if (
        await settleUnits(
          tx,
          row,
          units,
          InventoryReconciliationSource.SOURCE_IMPORT,
          source.ref,
          now,
        )
      ) {
        credit -= units;
        outcome.reconciled += units;
      }
    }
    const left = deductedUnits(row) - units;
    if (left > 0) {
      outcome.unresolved += left;
      if (units === 0) {
        await tx.inventoryReservation.updateMany({
          where: { id: row.id, status: Status.ALLOCATED },
          data: { reconciliationNote: noteFor(row).slice(0, 500) },
        });
      }
    }
  }
  return outcome;
}
