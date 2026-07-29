import { DealerStatus, Prisma } from '@prisma/client';

/**
 * Prisma `select` for an admin dealer row — only the columns the projection
 * needs. `_count.parts` yields the SKU count in the same query as the row, so a
 * page of dealers costs one read rather than one-per-dealer.
 */
export const ADMIN_DEALER_LIST_SELECT = {
  id: true,
  name: true,
  city: true,
  brandColor: true,
  color: true,
  logoUrl: true,
  initial: true,
  gmvUzs: true,
  ordersCount: true,
  certified: true,
  lowestPrice: true,
  status: true,
  joinedAt: true,
  updatedAt: true,
  _count: { select: { parts: true } },
} satisfies Prisma.CatalogSellerSelect;

/**
 * Prisma `select` for the dealer details view. A superset of the list row: the
 * same fields plus the contact/presentation data already stored on the row.
 * Adding fields is backward-compatible — the list shape stays embedded intact.
 */
export const ADMIN_DEALER_DETAIL_SELECT = {
  ...ADMIN_DEALER_LIST_SELECT,
  email: true,
  phoneE164: true,
  logoUrl: true,
  ratingAvg: true,
  years: true,
  isCurated: true,
  suspendedReason: true,
} satisfies Prisma.CatalogSellerSelect;

export type AdminDealerListRow = Prisma.CatalogSellerGetPayload<{
  select: typeof ADMIN_DEALER_LIST_SELECT;
}>;
export type AdminDealerDetail = Prisma.CatalogSellerGetPayload<{
  select: typeof ADMIN_DEALER_DETAIL_SELECT;
}>;

/**
 * Money leaves the API as an integer number of UZS. The column is a BigInt
 * because lifetime GMV overruns a 32-bit integer, but `JSON.stringify` refuses
 * to serialize a BigInt at all, so it is narrowed here. UZS amounts stay far
 * below Number.MAX_SAFE_INTEGER (9.0e15 — about 9 quadrillion so'm), so the
 * conversion is exact for every value this system can hold.
 */
function gmvToNumber(gmv: bigint): number {
  return Number(gmv);
}

export function presentAdminDealerRow(d: AdminDealerListRow) {
  return {
    id: d.id,
    name: d.name,
    city: d.city,
    // The console's own accent, falling back to the legacy storefront `color`
    // so a curated dealer that predates brandColor still renders in brand.
    brandColor: d.brandColor ?? d.color ?? null,
    logoUrl: d.logoUrl,
    initial: d.initial,
    gmvUzs: gmvToNumber(d.gmvUzs),
    orders: d.ordersCount,
    skus: d._count.parts,
    certified: d.certified,
    lowestPrice: d.lowestPrice,
    // Lowercased on the wire, exactly like the order console's status.
    status: d.status.toLowerCase(),
    joinedAt: d.joinedAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/**
 * Detail projection. Strictly a superset of the list row — every list field is
 * spread in unchanged — so a client written against the list shape keeps
 * working against this endpoint.
 */
export function presentAdminDealerDetail(d: AdminDealerDetail) {
  return {
    ...presentAdminDealerRow(d),
    email: d.email,
    phone: d.phoneE164,
    logoUrl: d.logoUrl,
    rating: Number(d.ratingAvg),
    years: d.years,
    certifiedPartner: d.isCurated,
    // Only meaningful while suspended; cleared on reactivation, so a stale
    // reason never trails an active dealer.
    suspendedReason:
      d.status === DealerStatus.SUSPENDED ? d.suspendedReason : null,
  };
}
