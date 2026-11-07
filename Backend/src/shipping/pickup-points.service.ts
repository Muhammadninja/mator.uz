import { Injectable } from '@nestjs/common';
import { CatalogProjectionService } from '../catalog/projection/catalog-projection.service';
import { findLineSellers } from '../orders/order-settlement';
import { PrismaService } from '../prisma/prisma.service';
import { supplySellerOf } from './delivery-quote.service';
import { toGeoPoint } from './routing/routing-provider';
// `import type`, as in delivery-quote.service.ts: a type only, never emitted as a value.
import type { GeoPoint } from './routing/routing-provider';

/**
 * Where a buyer who collects the order goes for each dealer's goods.
 *
 * A line's dealer is the storefront it is bought from: a catalog part's own seller, or the
 * Telegram seller behind an accepted sourcing offer. That is decided elsewhere, once
 * (findLineSellers), and an order freezes it on each line (OrderItem.sellerId), so the
 * checkout shows the dealer the order will record. The pickup point is what that dealer's
 * supply-side seller holds, the seller courier delivery is collected from (supplySellerOf):
 *   • name: the storefront's own name;
 *   • address: `sellers.address_comment`, the seller's address in its own words;
 *   • landmark: no dealer column holds one, so it is always null for now;
 *   • location: `sellers.location_lat` / `location_lng`.
 *
 * Nothing is made up. A dealer with no location has none (never a default point or another
 * dealer's), a dealer with no address has none, and a line whose dealer is not known is
 * listed as exactly that. Only the dealers of the lines given are read out.
 */

/** A goods line, as far as where it is collected cares. */
export interface PickupLine<TItem> {
  /** The storefront (CatalogSeller.id) the line is bought from. Null when not known. */
  storefrontId: string | null;
  /** The Telegram id of the seller behind a sourcing-offer line. Null on any other line. */
  offerSellerTgId: string | null;
  item: TItem;
}

/** Where one dealer's goods are collected, and which goods those are. */
export interface PickupPoint<TItem> {
  /** The storefront. Null only for the lines whose dealer is not known. */
  dealerId: string | null;
  dealerName: string | null;
  /** Null when the dealer has given no address. */
  address: string | null;
  /** Always null: no column holds a dealer's landmark yet. */
  landmark: string | null;
  /** Null when no real location is on record. Never a guess. */
  location: GeoPoint | null;
  items: TItem[];
}

/** A cart line under a pickup point. */
export interface CartPickupItem {
  cartItemId: string;
  partId: string | null;
  title: string;
  quantity: number;
}

/**
 * Goods, as courier delivery counts them: a part, an offer, or a line that names nothing (its
 * offer is gone). A service is done at its provider and has nothing to collect.
 */
export function isGoodsLine(line: {
  partId: string | null;
  offerId: string | null;
  serviceId: string | null;
}): boolean {
  return Boolean(line.partId || line.offerId || !line.serviceId);
}

const PICKUP_SELLER_SELECT = {
  id: true,
  tgId: true,
  catalogSellerId: true,
  storeName: true,
  marketName: true,
  addressComment: true,
  locationLat: true,
  locationLng: true,
} as const;

type PickupSeller = {
  id: number;
  tgId: bigint | null;
  catalogSellerId: string | null;
  storeName: string | null;
  marketName: string | null;
  addressComment: string | null;
  locationLat: number | null;
  locationLng: number | null;
};

const isTgId = (value: string | null): value is string =>
  value !== null && /^\d+$/.test(value);

/**
 * The Telegram seller behind a group's offer lines, when it is the seller the storefront is
 * named after. Only for a seller whose offers are its first goods, so no storefront row
 * records it yet.
 */
function offerSellerOf<TItem>(
  group: readonly PickupLine<TItem>[],
  sellers: readonly PickupSeller[],
  storefrontId: string,
): PickupSeller | undefined {
  for (const line of group) {
    const seller = sellers.find(
      (candidate) =>
        candidate.tgId !== null &&
        String(candidate.tgId) === line.offerSellerTgId,
    );
    if (
      seller &&
      CatalogProjectionService.catalogSellerIdFor(seller) === storefrontId
    ) {
      return seller;
    }
  }
  return undefined;
}

/**
 * One pickup point per dealer among these lines, in the order the lines first name them, and
 * the lines whose dealer is not known together last. Each point holds only its own dealer's
 * lines.
 */
export async function findPickupPoints<TItem>(
  prisma: Pick<PrismaService, 'catalogSeller' | 'seller'>,
  lines: readonly PickupLine<TItem>[],
): Promise<PickupPoint<TItem>[]> {
  const groups = new Map<string, PickupLine<TItem>[]>();
  const unknown: PickupLine<TItem>[] = [];
  for (const line of lines) {
    if (line.storefrontId === null) {
      unknown.push(line);
      continue;
    }
    const group = groups.get(line.storefrontId);
    if (group) group.push(line);
    else groups.set(line.storefrontId, [line]);
  }

  const storefrontIds = [...groups.keys()];
  const storefronts = storefrontIds.length
    ? await prisma.catalogSeller.findMany({
        where: { id: { in: storefrontIds } },
        select: { id: true, name: true, internalSellerId: true },
      })
    : [];
  const storefrontById = new Map(storefronts.map((s) => [s.id, s]));
  const internalSellerIds = storefronts.flatMap((s) =>
    s.internalSellerId === null ? [] : [s.internalSellerId],
  );
  const offerTgIds = [
    ...new Set(
      [...groups.values()].flatMap((group) =>
        group.flatMap((line) =>
          isTgId(line.offerSellerTgId) ? [line.offerSellerTgId] : [],
        ),
      ),
    ),
  ];
  const sellers: PickupSeller[] = storefrontIds.length
    ? await prisma.seller.findMany({
        where: {
          OR: [
            { catalogSellerId: { in: storefrontIds } },
            ...(internalSellerIds.length
              ? [{ id: { in: internalSellerIds } }]
              : []),
            ...(offerTgIds.length
              ? [{ tgId: { in: offerTgIds.map((id) => BigInt(id)) } }]
              : []),
          ],
        },
        select: PICKUP_SELLER_SELECT,
      })
    : [];

  const points = [...groups].map(
    ([storefrontId, group]): PickupPoint<TItem> => {
      const storefront = storefrontById.get(storefrontId);
      const seller =
        supplySellerOf(
          sellers,
          storefrontId,
          storefront?.internalSellerId ?? null,
        ) ?? offerSellerOf(group, sellers, storefrontId);
      return {
        dealerId: storefrontId,
        // A seller whose offer is its first sale has no storefront row yet. It is named as
        // the projection will name its storefront.
        dealerName:
          storefront?.name ?? seller?.storeName ?? seller?.marketName ?? null,
        address: seller?.addressComment?.trim() || null,
        landmark: null,
        location: seller
          ? toGeoPoint(seller.locationLat, seller.locationLng)
          : null,
        items: group.map((line) => line.item),
      };
    },
  );
  if (unknown.length > 0) {
    points.push({
      dealerId: null,
      dealerName: null,
      address: null,
      landmark: null,
      location: null,
      items: unknown.map((line) => line.item),
    });
  }
  return points;
}

/** A pickup point as the buyer's app reads it: snake_case, like the rest of checkout. */
export function presentCartPickupPoint(point: PickupPoint<CartPickupItem>) {
  return {
    dealer_id: point.dealerId,
    dealer_name: point.dealerName,
    address: point.address,
    landmark: point.landmark,
    location: point.location
      ? { lat: point.location.lat, lng: point.location.lng }
      : null,
    items: point.items.map((item) => ({
      cart_item_id: item.cartItemId,
      part_id: item.partId,
      title: item.title,
      quantity: item.quantity,
    })),
  };
}

@Injectable()
export class PickupPointsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Where the goods in the user's cart are collected, dealer by dealer. Read afresh each
   * time, from the same rule that names each line's dealer on the order.
   */
  async forCart(userId: string): Promise<PickupPoint<CartPickupItem>[]> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      select: {
        items: {
          select: {
            id: true,
            partId: true,
            offerId: true,
            serviceId: true,
            title: true,
            quantity: true,
            offer: { select: { sellerTgId: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const goods = (cart?.items ?? []).filter(isGoodsLine);
    if (goods.length === 0) return [];
    const storefronts = await findLineSellers(this.prisma, goods);
    return findPickupPoints(
      this.prisma,
      goods.map((line) => ({
        storefrontId: storefronts.get(line.id) ?? null,
        offerSellerTgId: line.offer?.sellerTgId ?? null,
        item: {
          cartItemId: line.id,
          partId: line.partId,
          title: line.title,
          quantity: line.quantity,
        },
      })),
    );
  }
}
