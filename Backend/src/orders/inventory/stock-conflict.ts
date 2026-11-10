import { ConflictException, Logger } from '@nestjs/common';
import {
  InventoryReservationStatus,
  Prisma,
  SourcingRequestStatus,
  SourcingStaffNotifyStatus,
  SourcingTicketStatus,
  StockShortageCause,
} from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { BUYER_LISTED_PART } from '../../catalog/buyer-visibility';
import {
  loadCategoryTreeScope,
  visibleCategoryWhere,
} from '../../catalog/categories/category-tree-scope';
import { chargedUnitPrices } from '../../cart/cart-pricing.util';
import { IdPrefix, prefixedId } from '../../common/ulid.util';
import type { PrismaService } from '../../prisma/prisma.service';
import type { DiscountService } from '../../sales/discount.service';
import { PART_UNAVAILABLE, UnavailableLine } from '../order-availability';
import { availableUnits, isCounted } from './inventory-availability';
import { deductedUnits } from './inventory-reservation.store';

/** Thrown inside the order transaction, so that it rolls back before anyone is told. */
export class StockConflictError extends Error {
  constructor(readonly lines: readonly UnavailableLine[]) {
    super('Not enough stock for this order');
  }
}

const MAX_ALTERNATIVES = 5;
const MAX_CANDIDATES = 40;
const SHORTAGE_VEHICLE_KEY = 'stock-shortage';

interface CartLine {
  id: string;
  partId: string | null;
  quantity: number;
}

interface Alternative {
  part_id: string;
  title: string;
  seller_name: string;
  price_uzs: number;
  /** Null for a listing nobody counted: its quantity is not limited. */
  available_quantity: number | null;
  covers_requested: boolean;
}

export const CAUSE_ON_THE_WIRE: Record<
  StockShortageCause,
  'source_stock' | 'reserved'
> = {
  [StockShortageCause.SOURCE_STOCK]: 'source_stock',
  [StockShortageCause.MATOR_RESERVATIONS]: 'reserved',
};

/**
 * Who stands between the buyer and these units? What Mator has sold is gone whether or
 * not the supplier's file says so yet, so only held units can come back.
 */
export function shortageCause(
  requested: number,
  reported: number,
  allocated: number,
): StockShortageCause {
  return requested > reported - allocated
    ? StockShortageCause.SOURCE_STOCK
    : StockShortageCause.MATOR_RESERVATIONS;
}

/**
 * Answers a checkout that cannot be supplied: the 409, the same part at other sellers,
 * and, when nobody has it, the existing sourcing ticket to the dealers group. Runs only
 * after the order was refused or rolled back. A failure in the bookkeeping never changes
 * the answer.
 */
export class StockConflictRefuser {
  private readonly logger = new Logger(StockConflictRefuser.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly discounts: DiscountService,
  ) {}

  async refuse(
    userId: string,
    cartLines: readonly CartLine[],
    shortages: readonly UnavailableLine[],
  ): Promise<never> {
    const lines = await this.describe(userId, cartLines, shortages);
    throw new ConflictException({
      code: PART_UNAVAILABLE,
      message: `No longer available: ${shortages
        .map((u) => `${u.title} (only ${u.availableQuantity ?? 0} available)`)
        .join('; ')}`,
      details: { lines },
    });
  }

  private async describe(
    userId: string,
    cartLines: readonly CartLine[],
    shortages: readonly UnavailableLine[],
  ) {
    const partIds = [...new Set(shortages.map((s) => s.partId))];
    const [parts, open, tree] = await Promise.all([
      this.prisma.catalogPart.findMany({
        where: { id: { in: partIds } },
        select: {
          id: true,
          title: true,
          sellerId: true,
          stockQty: true,
          reservedQty: true,
          oemNumbers: true,
          gmNumbers: true,
          seller: { select: { name: true } },
        },
      }),
      this.prisma.inventoryReservation.findMany({
        where: {
          partId: { in: partIds },
          status: {
            in: [
              InventoryReservationStatus.HELD,
              InventoryReservationStatus.ALLOCATED,
            ],
          },
        },
      }),
      loadCategoryTreeScope(this.prisma),
    ]);
    const byId = new Map(parts.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const out: unknown[] = [];

    for (const shortage of shortages) {
      if (seen.has(shortage.partId)) continue;
      seen.add(shortage.partId);
      const part = byId.get(shortage.partId);
      const requested = shortage.requestedQuantity ?? 0;
      const available = shortage.availableQuantity ?? 0;
      const allocated = open
        .filter(
          (r) =>
            r.partId === shortage.partId &&
            r.status === InventoryReservationStatus.ALLOCATED,
        )
        .reduce((sum, r) => sum + deductedUnits(r), 0);
      const cause = shortageCause(requested, part?.stockQty ?? 0, allocated);
      let alternatives: Alternative[] = [];
      let sourcingRequested = false;

      if (part) {
        alternatives = await this.findAlternatives(part, requested, tree).catch(
          (err: unknown) => {
            this.logger.error(
              `Alternatives for ${part.id} failed: ${String(err)}`,
            );
            return [];
          },
        );
        const cartLine = cartLines.find((l) => l.partId === shortage.partId);
        sourcingRequested = await this.record({
          userId,
          cartItemRef: cartLine?.id ?? shortage.partId,
          part,
          requested,
          available,
          held: open
            .filter(
              (r) =>
                r.partId === shortage.partId &&
                r.status === InventoryReservationStatus.HELD,
            )
            .reduce((sum, r) => sum + deductedUnits(r), 0),
          allocated,
          cause,
          alternatives,
        }).catch((err: unknown) => {
          this.logger.error(
            `Shortage record for ${part.id} failed: ${String(err)}`,
          );
          return false;
        });
      }

      out.push({
        part_id: shortage.partId,
        requested_quantity: requested,
        available_quantity: available,
        cause: CAUSE_ON_THE_WIRE[cause],
        sourcing_requested: sourcingRequested,
        alternatives,
      });
    }
    return out;
  }

  /**
   * The same part number at another seller, by the rules of the catalog: listed, in an
   * active category, not suspended. Offered at what checkout would charge, and never
   * applied by itself.
   */
  private async findAlternatives(
    part: {
      id: string;
      sellerId: string;
      oemNumbers: string[];
      gmNumbers: string[];
    },
    requested: number,
    tree: Parameters<typeof visibleCategoryWhere>[0],
  ): Promise<Alternative[]> {
    if (part.oemNumbers.length === 0 && part.gmNumbers.length === 0) return [];
    const rows = await this.prisma.catalogPart.findMany({
      where: {
        id: { not: part.id },
        sellerId: { not: part.sellerId },
        inStock: true,
        OR: [
          ...(part.gmNumbers.length
            ? [{ gmNumbers: { hasSome: part.gmNumbers } }]
            : []),
          ...(part.oemNumbers.length
            ? [{ oemNumbers: { hasSome: part.oemNumbers } }]
            : []),
        ],
        ...BUYER_LISTED_PART,
        ...visibleCategoryWhere(tree),
      },
      select: {
        id: true,
        title: true,
        priceUzs: true,
        stockQty: true,
        reservedQty: true,
        seller: { select: { name: true } },
      },
      orderBy: [{ priceUzs: 'asc' }, { id: 'asc' }],
      take: MAX_CANDIDATES,
    });
    const usable = rows.filter((r) => !isCounted(r) || availableUnits(r) > 0);
    const prices = await chargedUnitPrices(
      this.prisma,
      this.discounts,
      usable.map((r) => ({
        id: r.id,
        partId: r.id,
        offerId: null,
        serviceId: null,
        priceUzsSnapshot: r.priceUzs,
      })),
    );
    return usable
      .map((r) => {
        const available = isCounted(r) ? availableUnits(r) : null;
        return {
          part_id: r.id,
          title: r.title,
          seller_name: r.seller.name,
          price_uzs: prices.get(r.id) ?? Number(r.priceUzs),
          available_quantity: available,
          covers_requested: available === null || available >= requested,
        };
      })
      .sort((a, b) => Number(b.covers_requested) - Number(a.covers_requested))
      .slice(0, MAX_ALTERNATIVES);
  }

  /**
   * One row per cart line, quantity and cause. Whoever inserts it first owns the attempt,
   * and the ticket commits with that row, so a retry can neither open a second ticket nor
   * lose the first.
   *
   * @returns whether a sourcing ticket covers this request.
   */
  private async record(input: {
    userId: string;
    cartItemRef: string;
    part: {
      id: string;
      title: string;
      sellerId: string;
      stockQty: number;
      oemNumbers: string[];
      gmNumbers: string[];
      seller: { name: string };
    };
    requested: number;
    available: number;
    held: number;
    allocated: number;
    cause: StockShortageCause;
    alternatives: readonly Alternative[];
  }): Promise<boolean> {
    const { part, cause, requested } = input;
    const dedupeKey = `${input.cartItemRef}:${requested}:${cause}`;
    const partNumbers = [
      ...new Set([...part.gmNumbers, ...part.oemNumbers]),
    ].slice(0, 10);
    const wantsTicket =
      cause === StockShortageCause.SOURCE_STOCK &&
      !input.alternatives.some((a) => a.covers_requested);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const attempt = await tx.stockShortageAttempt.create({
          data: {
            id: prefixedId(IdPrefix.STOCK_SHORTAGE),
            dedupeKey,
            cartItemRef: input.cartItemRef,
            partId: part.id,
            title: part.title,
            partNumbers,
            sellerId: part.sellerId,
            sellerName: part.seller.name,
            requestedQty: requested,
            reportedQty: part.stockQty,
            heldQty: input.held,
            allocatedQty: input.allocated,
            availableQty: input.available,
            cause,
            alternativesCount: input.alternatives.length,
          },
        });
        if (!wantsTicket) return false;

        const partKey = `part:${part.id}`;
        const open = await tx.sourcingTicket.findFirst({
          where: {
            userId: input.userId,
            partKey,
            vehicleKey: SHORTAGE_VEHICLE_KEY,
            status: {
              in: [
                SourcingTicketStatus.PENDING,
                SourcingTicketStatus.IN_PROGRESS,
              ],
            },
          },
          select: { id: true },
        });
        const ticketId =
          open?.id ??
          (await this.openTicket(tx, input, attempt.id, partKey, partNumbers));
        await tx.stockShortageAttempt.update({
          where: { id: attempt.id },
          data: { sourcingTicketId: ticketId },
        });
        return true;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const again = await this.prisma.stockShortageAttempt.update({
          where: { dedupeKey },
          data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
          select: { sourcingTicketId: true },
        });
        return again.sourcingTicketId !== null;
      }
      throw err;
    }
  }

  /** The chat's ticket, in its outbox state: SourcingLifecycleService delivers it. */
  private async openTicket(
    tx: Prisma.TransactionClient,
    input: Parameters<StockConflictRefuser['record']>[0],
    attemptId: string,
    partKey: string,
    partNumbers: string[],
  ): Promise<string> {
    const { part, requested } = input;
    const rawMessage = `Stock shortage at checkout: ${part.title} x${requested}`;
    const request = await tx.sourcingRequest.create({
      data: {
        userId: input.userId,
        idempotencyKey: `stock-shortage:${attemptId}`,
        payloadHash: createHash('sha256').update(partKey).digest('hex'),
        status: SourcingRequestStatus.COMPLETED,
        response: {},
      },
    });
    const ticket = await tx.sourcingTicket.create({
      data: {
        id: randomUUID(),
        userId: input.userId,
        requestId: request.id,
        rawMessage,
        partName: part.title,
        partKey,
        vehicleKey: SHORTAGE_VEHICLE_KEY,
        extractedData: {
          part_name: part.title,
          stock_shortage: {
            part_id: part.id,
            part_numbers: partNumbers,
            requested_qty: requested,
            seller: part.seller.name,
            reported_qty: part.stockQty,
            reserved_qty: input.held + input.allocated,
            reference: attemptId,
          },
        },
        staffNotifyStatus: SourcingStaffNotifyStatus.PENDING,
        staffNotifyNextAt: new Date(),
      },
      select: { id: true },
    });
    return ticket.id;
  }
}
