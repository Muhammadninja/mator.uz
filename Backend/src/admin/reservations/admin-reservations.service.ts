import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminAuditAction,
  AdminAuditEntity,
  InventoryReservation,
  InventoryReservationStatus as Status,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import { AdminAuditService } from '../auth/admin-audit.service';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { clampLimit } from '../../common/pagination.util';
import { readOfflineOrderPolicy } from '../../orders/offline-order.policy';
import {
  deductedUnits,
  lockParts,
  reconcileRow,
  releaseRow,
  restockRow,
} from '../../orders/inventory/inventory-reservation.store';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ListReservationsQueryDto,
  ListShortagesQueryDto,
  ReservationView,
} from './dto/admin-reservations.dto';

const ENDED: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.EXPIRED,
  OrderStatus.REFUNDED,
];

function refuse(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

/**
 * The operator's view of promised stock, and the three things an operator may do about
 * it. None of them touches an order, a payment or the ledger, and each is audited. Who
 * may do this is who may edit inventory: nothing new was granted.
 */
@Injectable()
export class AdminReservationsService {
  private readonly longHeldHours: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    config: ConfigService,
  ) {
    this.longHeldHours = readOfflineOrderPolicy((key) =>
      config.get<string>(key),
    ).operatorWarningHours;
  }

  private viewWhere(
    view: ReservationView,
    now: Date,
  ): Prisma.InventoryReservationWhereInput {
    switch (view) {
      case 'held':
        return { status: Status.HELD };
      case 'allocated':
        return { status: Status.ALLOCATED };
      case 'long_held':
        return {
          status: Status.HELD,
          expiresAt: null,
          createdAt: {
            lt: new Date(now.getTime() - this.longHeldHours * 3_600_000),
          },
        };
      case 'needs_review':
        return { status: Status.ALLOCATED, reconciliationNote: { not: null } };
      case 'return_pending':
        return { status: Status.ALLOCATED, returnPendingAt: { not: null } };
      case 'released':
        return { status: Status.RELEASED };
      case 'reconciled':
        return { status: Status.RECONCILED };
      case 'all':
        return {};
      default:
        return { status: { in: [Status.HELD, Status.ALLOCATED] } };
    }
  }

  async list(query: ListReservationsQueryDto) {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = clampLimit(query.limit, 25, 100);
    const now = new Date();
    const where: Prisma.InventoryReservationWhereInput = {
      ...this.viewWhere(query.view ?? 'active', now),
      ...(query.orderId ? { orderRef: query.orderId } : {}),
      ...(query.sellerId ? { sellerId: query.sellerId } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.inventoryReservation.count({ where }),
      this.prisma.inventoryReservation.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          part: { select: { stockQty: true, reservedQty: true } },
          order: { select: { status: true, paymentType: true } },
        },
      }),
    ]);
    const totals = await this.openUnitsByPart(
      rows.map((r) => r.partId).filter((id): id is string => !!id),
    );
    return {
      success: true,
      data: rows.map((row) => this.present(row, totals, now)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async summary() {
    const now = new Date();
    const count = (view: ReservationView) =>
      this.prisma.inventoryReservation.count({
        where: this.viewWhere(view, now),
      });
    const [held, allocated, longHeld, needsReview, returnPending] =
      await Promise.all([
        count('held'),
        count('allocated'),
        count('long_held'),
        count('needs_review'),
        count('return_pending'),
      ]);
    return {
      success: true,
      data: { held, allocated, longHeld, needsReview, returnPending },
    };
  }

  async shortages(query: ListShortagesQueryDto) {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = clampLimit(query.limit, 25, 100);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.stockShortageAttempt.count(),
      this.prisma.stockShortageAttempt.findMany({
        orderBy: [{ lastAttemptAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const ticketIds = rows
      .map((r) => r.sourcingTicketId)
      .filter((id): id is string => !!id);
    const tickets = new Map(
      (ticketIds.length
        ? await this.prisma.sourcingTicket.findMany({
            where: { id: { in: ticketIds } },
            select: { id: true, status: true, staffNotifyStatus: true },
          })
        : []
      ).map((t) => [t.id, t]),
    );
    return {
      success: true,
      data: rows.map((row) => {
        const ticket = row.sourcingTicketId
          ? tickets.get(row.sourcingTicketId)
          : undefined;
        return {
          id: row.id,
          partId: row.partId,
          title: row.title,
          partNumbers: row.partNumbers,
          seller: row.sellerName,
          requestedQty: row.requestedQty,
          reportedQty: row.reportedQty,
          heldQty: row.heldQty,
          allocatedQty: row.allocatedQty,
          availableQty: row.availableQty,
          cause: row.cause,
          alternativesCount: row.alternativesCount,
          attempts: row.attempts,
          sourcingTicketId: row.sourcingTicketId,
          sourcingStatus: ticket?.status ?? null,
          sourcingNotifyStatus: ticket?.staffNotifyStatus ?? null,
          createdAt: row.createdAt.toISOString(),
          lastAttemptAt: row.lastAttemptAt.toISOString(),
        };
      }),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  /** The operator states that the supplier's own count now includes this sale. */
  reconcile(id: string, reason: string, ctx: AdminAuditContext) {
    return this.act(
      id,
      AdminAuditAction.INVENTORY_RESERVATION_RECONCILED,
      reason,
      ctx,
      async (tx, row) => {
        if (row.status !== Status.ALLOCATED) {
          throw refuse(
            'RESERVATION_NOT_ALLOCATED',
            'Only a sold quantity can be reconciled.',
          );
        }
        return reconcileRow(
          tx,
          row,
          `Operator ${ctx.actor?.name ?? ''}: ${reason}`.trim(),
        );
      },
    );
  }

  /** Repair only: a live order is released by cancelling it. */
  release(id: string, reason: string, ctx: AdminAuditContext) {
    return this.act(
      id,
      AdminAuditAction.INVENTORY_RESERVATION_RELEASED,
      reason,
      ctx,
      async (tx, row) => {
        if (row.status !== Status.HELD && row.status !== Status.ALLOCATED) {
          throw refuse(
            'RESERVATION_NOT_OPEN',
            'This reservation is already closed.',
          );
        }
        const order = row.orderId
          ? await tx.order.findUnique({
              where: { id: row.orderId },
              select: {
                status: true,
                offlineCollection: { select: { id: true } },
              },
            })
          : null;
        if (
          !order ||
          !ENDED.includes(order.status) ||
          order.offlineCollection ||
          row.fulfilledAt ||
          row.returnPendingAt
        ) {
          throw refuse(
            'RESERVATION_RELEASE_NOT_ALLOWED',
            'Stock comes back by cancelling the order, or by a restock once the goods have returned.',
          );
        }
        return releaseRow(tx, row, `Operator: ${reason}`);
      },
    );
  }

  /** Returned goods, unit by unit. Nothing else puts a sold unit back on sale. */
  restock(
    id: string,
    quantity: number,
    reason: string,
    ctx: AdminAuditContext,
  ) {
    return this.act(
      id,
      AdminAuditAction.INVENTORY_RESERVATION_RESTOCKED,
      reason,
      ctx,
      async (tx, row) => {
        if (row.status !== Status.ALLOCATED) {
          throw refuse(
            'RESERVATION_NOT_ALLOCATED',
            'Only an open sale can be restocked. Once the supplier has counted a sale, its next file shows the return.',
          );
        }
        const order = row.orderId
          ? await tx.order.findUnique({
              where: { id: row.orderId },
              select: { status: true },
            })
          : null;
        if (
          !order ||
          ![...ENDED, OrderStatus.DELIVERED].includes(order.status)
        ) {
          throw refuse(
            'RESERVATION_ORDER_IN_PROGRESS',
            'This order is still in progress.',
          );
        }
        if (quantity > deductedUnits(row)) {
          throw refuse(
            'RESTOCK_EXCEEDS_RESERVATION',
            `Only ${deductedUnits(row)} can be restocked.`,
          );
        }
        return restockRow(tx, row, quantity);
      },
    );
  }

  /** Part lock, then a fresh read, the order every writer of these rows follows. */
  private async act(
    id: string,
    action: AdminAuditAction,
    reason: string,
    ctx: AdminAuditContext,
    apply: (
      tx: Prisma.TransactionClient,
      row: InventoryReservation,
    ) => Promise<boolean>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const located = await tx.inventoryReservation.findUnique({
        where: { id },
        select: { partId: true },
      });
      if (!located) throw new NotFoundException('Reservation not found');
      if (located.partId) await lockParts(tx, [located.partId]);
      const row = await tx.inventoryReservation.findUniqueOrThrow({
        where: { id },
      });
      if (!(await apply(tx, row))) {
        throw refuse(
          'RESERVATION_CHANGED',
          'This reservation just changed. Reload and try again.',
        );
      }
      const after = await tx.inventoryReservation.findUniqueOrThrow({
        where: { id },
      });
      await this.audit.record(
        {
          action,
          actor: ctx.actor,
          actorLabel: ctx.actorLabel,
          target: {
            entity: AdminAuditEntity.ORDER,
            id: row.orderRef,
            name: row.orderRef,
          },
          previousValues: {
            reservationId: id,
            status: row.status,
            reconciledQty: row.reconciledQty,
            restockedQty: row.restockedQty,
          },
          newValues: {
            status: after.status,
            reconciledQty: after.reconciledQty,
            restockedQty: after.restockedQty,
          },
          reason,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        tx,
      );
      return { success: true, data: { id, status: after.status } };
    });
  }

  private async openUnitsByPart(partIds: string[]) {
    const totals = new Map<string, { held: number; allocated: number }>();
    if (partIds.length === 0) return totals;
    const open = await this.prisma.inventoryReservation.findMany({
      where: {
        partId: { in: [...new Set(partIds)] },
        status: { in: [Status.HELD, Status.ALLOCATED] },
      },
      select: {
        partId: true,
        status: true,
        quantity: true,
        reconciledQty: true,
        restockedQty: true,
      },
    });
    for (const row of open) {
      const entry = totals.get(row.partId!) ?? { held: 0, allocated: 0 };
      if (row.status === Status.HELD) entry.held += deductedUnits(row);
      else entry.allocated += deductedUnits(row);
      totals.set(row.partId!, entry);
    }
    return totals;
  }

  private present(
    row: InventoryReservation & {
      part: { stockQty: number; reservedQty: number } | null;
      order: { status: OrderStatus; paymentType: string | null } | null;
    },
    totals: Map<string, { held: number; allocated: number }>,
    now: Date,
  ) {
    const open = row.partId ? totals.get(row.partId) : undefined;
    const reported = row.part?.stockQty ?? null;
    const promised = row.part?.reservedQty ?? 0;
    return {
      id: row.id,
      orderId: row.orderRef,
      orderStatus: row.order?.status ?? null,
      paymentType: row.order?.paymentType ?? null,
      partId: row.partRef,
      title: row.title,
      partNumbers: row.partNumbers,
      sellerId: row.sellerId,
      seller: row.sellerName,
      quantity: row.quantity,
      deducted:
        row.status === Status.HELD || row.status === Status.ALLOCATED
          ? deductedUnits(row)
          : 0,
      reconciledQty: row.reconciledQty,
      restockedQty: row.restockedQty,
      status: row.status,
      reconciliationStatus: this.reconciliationStatus(row),
      reconciliationNote: row.reconciliationNote,
      reconciliationSource: row.reconciliationSource,
      reconciliationRef: row.reconciliationRef,
      supplierReported: reported,
      heldQty: open?.held ?? 0,
      allocatedQty: open?.allocated ?? 0,
      availableQty: reported === null ? null : Math.max(0, reported - promised),
      // More is promised than the supplier now says exists: someone has to look.
      stockConflict: reported !== null && promised > reported,
      longHeld:
        row.status === Status.HELD &&
        row.expiresAt === null &&
        row.createdAt.getTime() <
          now.getTime() - this.longHeldHours * 3_600_000,
      returnPending: row.returnPendingAt !== null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      statusChangedAt: row.statusChangedAt.toISOString(),
    };
  }

  private reconciliationStatus(row: InventoryReservation) {
    if (row.status === Status.RECONCILED) return 'reconciled';
    if (row.status !== Status.ALLOCATED) return 'not_applicable';
    if (row.reconciliationNote)
      return row.reconciledQty > 0 ? 'partial' : 'needs_review';
    return row.reconciledQty > 0 ? 'partial' : 'awaiting_source';
  }
}
