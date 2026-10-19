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
 * This is the purchase gate (cart). What the catalog LISTS is narrower — see
 * BUYER_LISTED_PART.
 */
export const BUYER_VISIBLE_PART = {
  seller: { status: { not: DealerStatus.SUSPENDED } },
} satisfies Prisma.CatalogPartWhereInput;

/**
 * Which parts the buyer CATALOG lists: buyer-visible AND at least one READY
 * photo. A part without one is not deleted or changed (price, stock, seller,
 * fitment stay as they are) — it is just not listed until it has a photo.
 *
 * `catalog_parts.images` only ever holds finished photos. The image pipeline
 * (the BullMQ worker over product_draft_images) marks a photo READY once its
 * processed upload exists; the confirm of a Telegram listing or of a Driver's
 * Village `1C` photo update writes the READY ones into product_images, and the
 * projection copies those here. A photo still queued or processing, or one
 * that FAILED, never leaves its draft. So an empty array means "no ready photo
 * yet" (e.g. a fresh 1C import), and the part is listed by itself once a photo
 * update is projected — there is no status to flip.
 *
 * `isEmpty: false` compiles to `images <> '{}'`, which a NULL array (the column
 * is nullable) never satisfies: NULL is no photo either.
 *
 * For catalog READS: the listing with its counts and facets, the detail,
 * search, typeahead, quick filters, category counts and the AI catalog lookups.
 * The cart keeps BUYER_VISIBLE_PART: whether a part can be bought is order
 * logic, which a photo does not change.
 */
export const BUYER_LISTED_PART = {
  ...BUYER_VISIBLE_PART,
  images: { isEmpty: false },
} satisfies Prisma.CatalogPartWhereInput;

/** `where` AND buyer-listed, without clobbering a caller's own `seller` filter. */
export function buyerListed(
  where?: Prisma.CatalogPartWhereInput,
): Prisma.CatalogPartWhereInput {
  return where ? { AND: [BUYER_LISTED_PART, where] } : BUYER_LISTED_PART;
}
