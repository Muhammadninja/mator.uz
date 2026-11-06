import { Prisma } from '@prisma/client';
import { CatalogProjectionService } from '../catalog/projection/catalog-projection.service';
import { PrismaService } from '../prisma/prisma.service';
import { toTiyin } from './service-fee.util';

/**
 * Whose money an order holds. The buyer pays Mator the whole total, and Mator settles with
 * the sellers afterwards. Nothing in this system pays anyone yet: this is what such a payout
 * reads, so it cannot pick up a figure that is not the seller's.
 *
 * What a seller is owed is the sum of their lines, as charged. Those lines hold no service
 * fee and no delivery: both are separate columns on the order, and both are Mator's lines on
 * the receipt. So this needs no subtraction from the total, which is what keeps the fee out
 * by construction rather than by remembering to take it off.
 *
 * A promo discount is spread into the line prices when an order is created, so a line's total
 * is net of it. Whether a seller or Mator bears that discount is a business decision this
 * does not make: see "Whose money an order holds" in docs/CATEGORY_ARCHITECTURE.md.
 *
 * Refunds are not taken off here. The registry says how much went back and how much of that
 * was the fee, but not which seller's goods the rest was for.
 */

/** A cart line, as far as finding its seller cares. */
export interface SellerLine {
  id: string;
  partId: string | null;
  offer?: { sellerTgId: string } | null;
}

/**
 * The storefront behind each goods line, by line id, to be frozen on the order. Read when the
 * order is placed, since the catalog can change afterwards. A line whose seller cannot be
 * found gets no entry: nothing is guessed about who is owed money.
 */
export async function findLineSellers(
  prisma: Pick<PrismaService, 'catalogPart' | 'seller'>,
  lines: readonly SellerLine[],
): Promise<Map<string, string>> {
  const partIds = [
    ...new Set(lines.flatMap((line) => (line.partId ? [line.partId] : []))),
  ];
  const parts = partIds.length
    ? await prisma.catalogPart.findMany({
        where: { id: { in: partIds } },
        select: { id: true, sellerId: true },
      })
    : [];
  const sellerOfPart = new Map(parts.map((part) => [part.id, part.sellerId]));

  const tgIds = [
    ...new Set(
      lines.flatMap((line) =>
        !line.partId && line.offer && /^\d+$/.test(line.offer.sellerTgId)
          ? [line.offer.sellerTgId]
          : [],
      ),
    ),
  ];
  const sellers = tgIds.length
    ? await prisma.seller.findMany({
        where: { tgId: { in: tgIds.map((id) => BigInt(id)) } },
        select: { id: true, tgId: true, catalogSellerId: true },
      })
    : [];
  const storefrontOfTgId = new Map(
    sellers.map((seller) => [
      String(seller.tgId),
      CatalogProjectionService.catalogSellerIdFor(seller),
    ]),
  );

  const out = new Map<string, string>();
  for (const line of lines) {
    const seller = line.partId
      ? sellerOfPart.get(line.partId)
      : line.offer
        ? storefrontOfTgId.get(line.offer.sellerTgId)
        : undefined;
    if (seller) out.set(line.id, seller);
  }
  return out;
}

/** An order, as far as splitting its money cares. */
export interface SettlementOrder {
  serviceFeeUzs: Prisma.Decimal.Value;
  deliveryUzs: Prisma.Decimal.Value;
  totalUzs: Prisma.Decimal.Value;
  items: {
    sellerId?: string | null;
    providerId?: string | null;
    lineTotalUzs: Prisma.Decimal.Value;
  }[];
}

export interface OrderSettlement {
  /** What each seller's goods brought in, as charged. Never the fee, never delivery. */
  sellers: { sellerId: string; amountUzs: number }[];
  /** The same for each provider of a service line. */
  providers: { providerId: string; amountUzs: number }[];
  /** Lines nobody can be named for, as on an order placed before sellers were recorded. */
  unattributedUzs: number;
  /** Mator's own income from this order. */
  serviceFeeUzs: number;
  /** Delivery is Mator's line on the receipt, not a seller's. */
  deliveryUzs: number;
  /** What the buyer paid. Everything above adds up to it. */
  totalUzs: number;
}

const tiyinOf = (value: Prisma.Decimal.Value): number => toTiyin(Number(value));

function addTo(totals: Map<string, number>, key: string, tiyin: number): void {
  totals.set(key, (totals.get(key) ?? 0) + tiyin);
}

/** The order's money, by who it belongs to. Pure, and worked in tiyin. */
export function settleOrder(order: SettlementOrder): OrderSettlement {
  const sellers = new Map<string, number>();
  const providers = new Map<string, number>();
  let unattributed = 0;
  for (const item of order.items) {
    const tiyin = tiyinOf(item.lineTotalUzs);
    if (item.sellerId) addTo(sellers, item.sellerId, tiyin);
    else if (item.providerId) addTo(providers, item.providerId, tiyin);
    else unattributed += tiyin;
  }
  return {
    sellers: [...sellers].map(([sellerId, tiyin]) => ({
      sellerId,
      amountUzs: tiyin / 100,
    })),
    providers: [...providers].map(([providerId, tiyin]) => ({
      providerId,
      amountUzs: tiyin / 100,
    })),
    unattributedUzs: unattributed / 100,
    serviceFeeUzs: tiyinOf(order.serviceFeeUzs) / 100,
    deliveryUzs: tiyinOf(order.deliveryUzs) / 100,
    totalUzs: tiyinOf(order.totalUzs) / 100,
  };
}
