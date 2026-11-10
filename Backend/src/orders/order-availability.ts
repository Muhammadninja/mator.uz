import { ConflictException } from '@nestjs/common';
import {
  DealerStatus,
  SellerStatus,
  SourcingOfferStatus,
  SourcingTicketStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loadCategoryTreeScope } from '../catalog/categories/category-tree-scope';
import {
  inventoryReservationsEnabled,
  isOutOfStock,
  reservedUnits,
} from './inventory/inventory-availability';

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
 * their quantity is not limited. A Driver's Village row is never one of them: its 0 is
 * out of stock even if `inStock` disagrees (isOutOfStock). Any other value of `stockQty`
 * is the amount on hand.
 *
 * With inventory reservations on, what counts is the count less what Mator has promised
 * (see inventory-availability.ts). Called under the part locks of order creation, that is
 * what stops two buyers each ordering the last unit. Paying for an existing order goes
 * through findUnavailableForPayment, which leaves out that order's own units and nobody
 * else's.
 */
export type UnavailableReason =
  | 'missing'
  | 'out_of_stock'
  | 'dealer_suspended'
  | 'no_price'
  | 'insufficient_stock'
  | 'category_hidden'
  // Paying for an order whose hold ran out: it has no claim on the stock any more.
  | 'reservation_expired'
  // LOW-ORD-007: lines that are not catalog parts.
  | 'offer_unavailable'
  | 'seller_ineligible'
  | 'service_unavailable'
  | 'provider_mismatch'
  | 'invalid_quantity';

export interface UnavailableLine {
  partId: string;
  title: string;
  reason: UnavailableReason;
  /** With `insufficient_stock`: what is on hand, and what was asked for. */
  availableQuantity?: number;
  requestedQuantity?: number;
}

/** Refused for quantity alone, as opposed to a part that cannot be sold at all. */
export function isShortage(line: UnavailableLine): boolean {
  return line.reason === 'insufficient_stock' || line.reason === 'out_of_stock';
}

/** Does this count refuse `requested`? Only ever reached with `inStock` true, see above. */
export function exceedsCountedStock(
  stockQty: number,
  requested: number,
  reservedQty = 0,
): boolean {
  return stockQty > 0 && requested > stockQty - reservedQty;
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

/** A cart or order line, as far as availability is concerned. */
export interface AvailabilityLine {
  partId: string | null;
  title: string;
  quantity?: number;
  offerId?: string | null;
  serviceId?: string | null;
  providerId?: string | null;
}

type AvailabilityDb = Pick<PrismaService, 'catalogPart' | 'partCategory'> &
  Partial<
    Pick<PrismaService, 'sourcingOffer' | 'seller' | 'providerServiceOffering'>
  >;

export async function findUnavailableParts(
  prisma: AvailabilityDb,
  lines: readonly AvailabilityLine[],
  options: {
    /**
     * Paying for an existing order (see payment-availability.ts): per part, the units
     * promised to OTHER orders that come before this one. A part not in the map is held
     * against every reservation, as for a new buyer.
     */
    reservedAhead?: ReadonlyMap<string, number>;
    /** Parts this order held, whose hold has run out. */
    lapsedParts?: ReadonlySet<string>;
  } = {},
): Promise<UnavailableLine[]> {
  const otherLines = await findUnavailableOtherLines(prisma, lines);
  const partLines = lines.filter(
    (l): l is { partId: string; title: string; quantity?: number } => !!l.partId,
  );
  if (partLines.length === 0) return otherLines;

  const parts = await prisma.catalogPart.findMany({
    where: { id: { in: [...new Set(partLines.map((l) => l.partId))] } },
    select: {
      id: true,
      inStock: true,
      stockQty: true,
      ...(inventoryReservationsEnabled() ? { reservedQty: true } : {}),
      priceUzs: true,
      categoryId: true,
      sellerId: true,
      seller: { select: { status: true } },
    },
  });
  const reservedOf = (part: { id: string; reservedQty?: number | null }) =>
    options.reservedAhead?.get(part.id) ?? reservedUnits(part);
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
        : isOutOfStock(part)
          ? 'out_of_stock'
          : options.lapsedParts?.has(part.id)
            ? 'reservation_expired'
          : Number(part.priceUzs) <= 0
            ? 'no_price'
            : exceedsCountedStock(
                  part.stockQty,
                  requestedByPart.get(line.partId) ?? 0,
                  reservedOf(part),
                )
              ? 'insufficient_stock'
              : null;
    if (reason === 'insufficient_stock' || reason === 'out_of_stock') {
      unavailable.push({
        partId: line.partId,
        title: line.title,
        reason,
        availableQuantity:
          reason === 'out_of_stock'
            ? 0
            : Math.max(0, part!.stockQty - reservedOf(part!)),
        requestedQuantity: requestedByPart.get(line.partId),
      });
    } else if (reason) {
      unavailable.push({ partId: line.partId, title: line.title, reason });
    }
  }
  return [...unavailable, ...otherLines];
}

/** Ticket states in which a bought offer can no longer be delivered. */
const DEAD_TICKET_STATUSES: readonly SourcingTicketStatus[] = [
  SourcingTicketStatus.CANCELLED,
  SourcingTicketStatus.CLOSED,
];

/**
 * Lines that are not catalog parts (LOW-ORD-007): a bought sourcing offer, or a
 * provider's service. Neither has stock, so no count is checked; what is checked
 * is that it can still be sold, on the same three gates as parts (cart, order
 * creation, payment):
 *
 *   • an offer is exactly one item, still ACCEPTED (not expired, declined or
 *     removed), on a ticket nobody cancelled or closed, from a seller who is not
 *     REJECTED;
 *   • a service is booked once per line, still offered, by an active provider,
 *     and the line names the provider that really offers it.
 *
 * `partId` on the result carries the offer or service id so the existing 409
 * shape names the line.
 */
async function findUnavailableOtherLines(
  prisma: AvailabilityDb,
  lines: readonly AvailabilityLine[],
): Promise<UnavailableLine[]> {
  const offerLines = lines.filter((l) => !l.partId && l.offerId);
  const serviceLines = lines.filter((l) => !l.partId && l.serviceId);
  if (offerLines.length === 0 && serviceLines.length === 0) return [];
  const unavailable: UnavailableLine[] = [];

  if (offerLines.length > 0) {
    if (!prisma.sourcingOffer || !prisma.seller) {
      throw new Error('Offer lines need the sourcingOffer and seller delegates');
    }
    const offers = await prisma.sourcingOffer.findMany({
      where: { id: { in: offerLines.map((l) => l.offerId!) } },
      select: {
        id: true,
        status: true,
        sellerTgId: true,
        ticket: { select: { status: true } },
      },
    });
    const tgIds = [
      ...new Set(
        offers
          .map((o) => o.sellerTgId)
          .filter((id) => /^\d{1,19}$/.test(id)),
      ),
    ].map((id) => BigInt(id));
    const sellers = tgIds.length
      ? await prisma.seller.findMany({
          where: { tgId: { in: tgIds } },
          select: { tgId: true, status: true },
        })
      : [];
    const rejected = new Set(
      sellers
        .filter((s) => s.status === SellerStatus.REJECTED)
        .map((s) => String(s.tgId)),
    );
    const byId = new Map(offers.map((o) => [o.id, o]));
    for (const line of offerLines) {
      const offer = byId.get(line.offerId!);
      const reason: UnavailableReason | null = !offer
        ? 'offer_unavailable'
        : (line.quantity ?? 1) !== 1
          ? 'invalid_quantity'
          : offer.status !== SourcingOfferStatus.ACCEPTED ||
              DEAD_TICKET_STATUSES.includes(offer.ticket.status)
            ? 'offer_unavailable'
            : rejected.has(offer.sellerTgId)
              ? 'seller_ineligible'
              : null;
      if (reason) {
        unavailable.push({ partId: line.offerId!, title: line.title, reason });
      }
    }
  }

  if (serviceLines.length > 0) {
    if (!prisma.providerServiceOffering) {
      throw new Error('Service lines need the providerServiceOffering delegate');
    }
    const services = await prisma.providerServiceOffering.findMany({
      where: { id: { in: serviceLines.map((l) => l.serviceId!) } },
      select: {
        id: true,
        providerId: true,
        priceUzs: true,
        provider: { select: { isActive: true } },
      },
    });
    const byId = new Map(services.map((svc) => [svc.id, svc]));
    for (const line of serviceLines) {
      const svc = byId.get(line.serviceId!);
      const reason: UnavailableReason | null = !svc || !svc.provider.isActive
        ? 'service_unavailable'
        : (line.quantity ?? 1) !== 1
          ? 'invalid_quantity'
          : line.providerId && line.providerId !== svc.providerId
            ? 'provider_mismatch'
            : Number(svc.priceUzs) <= 0
              ? 'no_price'
              : null;
      if (reason) {
        unavailable.push({
          partId: line.serviceId!,
          title: line.title,
          reason,
        });
      }
    }
  }
  return unavailable;
}

/** 409 { code: PART_UNAVAILABLE } naming the lines, when any is unavailable. */
export function assertAllAvailable(
  unavailable: readonly UnavailableLine[],
): void {
  if (unavailable.length === 0) return;
  const short = unavailable.filter(isShortage);
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
