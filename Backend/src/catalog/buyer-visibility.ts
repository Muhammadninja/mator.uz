import { DealerStatus, Prisma } from '@prisma/client';

/**
 * Which catalog parts a BUYER may see or buy.
 *
 * A dealer an admin SUSPENDED (admin dealer console: ACTIVE → SUSPENDED) is out
 * of the marketplace: its parts must not stay listed, searchable or purchasable
 * while the storefront is suspended. Reactivation brings them back unchanged —
 * nothing is deleted.
 *
 * Only SUSPENDED is excluded. PENDING is the schema default and the state of
 * every storefront the projection creates for a Telegram seller (whose own
 * approval is enforced in the seller bot), so requiring ACTIVE here would hide
 * most of the catalogue.
 */
export const BUYER_VISIBLE_PART = {
  seller: { status: { not: DealerStatus.SUSPENDED } },
} satisfies Prisma.CatalogPartWhereInput;

/** `where` AND buyer-visible, without clobbering a caller's own `seller` filter. */
export function buyerVisible(
  where?: Prisma.CatalogPartWhereInput,
): Prisma.CatalogPartWhereInput {
  return where ? { AND: [BUYER_VISIBLE_PART, where] } : BUYER_VISIBLE_PART;
}
