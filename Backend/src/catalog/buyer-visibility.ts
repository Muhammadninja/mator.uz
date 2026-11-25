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
 *
 * This is the purchase gate (cart). What the catalog LISTS is narrower (no
 * zero price) — see BUYER_LISTED_PART.
 */
export const BUYER_VISIBLE_PART = {
  seller: { status: { not: DealerStatus.SUSPENDED } },
} satisfies Prisma.CatalogPartWhereInput;

/**
 * Which parts the buyer CATALOG lists: buyer-visible AND a positive price.
 *
 * A photo is NOT required. A part with an empty (or NULL) `images` array — e.g.
 * a fresh Driver's Village 1C import — is listed too, and the app shows its
 * placeholder image. (From 2026-10-19 photo-less parts were hidden; the owner
 * reverted that.)
 *
 * For catalog READS: the listing with its counts and facets, the detail,
 * search, typeahead, quick filters, category counts and the AI catalog lookups.
 * The cart keeps BUYER_VISIBLE_PART: whether a part can be bought is order
 * logic.
 */
export const BUYER_LISTED_PART = {
  ...BUYER_VISIBLE_PART,
  // A price of 0 is a data error: the order gate refuses it, so the listing must
  // not offer what checkout will reject.
  NOT: { priceUzs: { lte: 0 } },
} satisfies Prisma.CatalogPartWhereInput;

/** `where` AND buyer-listed, without clobbering a caller's own `seller` filter. */
export function buyerListed(
  where?: Prisma.CatalogPartWhereInput,
): Prisma.CatalogPartWhereInput {
  return where ? { AND: [BUYER_LISTED_PART, where] } : BUYER_LISTED_PART;
}
